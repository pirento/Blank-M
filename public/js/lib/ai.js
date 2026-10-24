/**
 * Browser client for the AI endpoints: chat (streamed), research picks and
 * history, briefing, analysis, review, transcription, journal search and
 * small helpers. Every request is bound to the signed-in member.
 */
import { z } from 'zod';
import {
  MAX_CHAT_HISTORY_MESSAGES,
  analyzeResponseSchema,
  briefingResponseSchema,
  draftedRuleSchema,
  journalSearchResponseSchema,
  picksResponseSchema,
  researchHistoryResponseSchema,
  reviewResponseSchema,
  symbolResponseSchema,
  textResponseSchema,
  transcriptionResponseSchema,
} from '../../../shared/ai-schemas.js';
import { api, requestHeaders } from '../core/api.js';

const REQUEST_TIMEOUT_MS = 120_000;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export class AiRequestError extends Error {
  constructor(message, status, code = 'failed') {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'AiRequestError';
  }
}

/** Session cookie, CSRF token and the rendering login's identity. */
async function authorizedHeaders(json = true) {
  return requestHeaders(json);
}

async function post(path, body, schema, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = window.setTimeout(cancel, REQUEST_TIMEOUT_MS);
  try {
    controller.signal.throwIfAborted();
    const headers = await awaitWithAbort(authorizedHeaders(), controller.signal);
    controller.signal.throwIfAborted();
    const response = await awaitWithAbort(
      fetch(`/api/ai/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      controller.signal,
    );
    const payload = await awaitWithAbort(
      response.json().catch(() => null),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String(payload.error)
          : `Request failed (${response.status})`;
      throw new AiRequestError(message, response.status);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success)
      throw new AiRequestError('The server returned an unexpected response.', 502);
    return parsed.data;
  } catch (error) {
    if (controller.signal.aborted) {
      throw signal?.aborted
        ? new AiRequestError('Request cancelled.', 499, 'cancelled')
        : new AiRequestError(
            'The AI took too long to respond. Try a shorter request.',
            504,
            'timeout',
          );
    }
    if (error instanceof AiRequestError) throw error;
    throw new AiRequestError('Could not reach the AI service.', 0);
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Keep the newest context without mutating the visible or persisted conversation. */
export function recentChatHistory(history) {
  return history.slice(-MAX_CHAT_HISTORY_MESSAGES);
}

const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({
    type: z.literal('error'),
    error: z.string().optional(),
    code: z.enum(['failed', 'incomplete']).optional(),
  }),
]);

/** Stop waiting locally even when a preparation step has no cancellation API.
 * The underlying operation is still observed, so a late rejection is handled.
 */
export function awaitWithAbort(operation, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

/**
 * POST a chat turn to /api/ai/chat and read the server-sent event stream. Calls
 * `options.onDelta(textSoFar)` per chunk and resolves to the full answer only after a `done`
 * event; throws AiRequestError on cancel (499), timeout (504) or an incomplete/invalid stream.
 */
export async function requestChat(options) {
  const controller = new AbortController();
  let reader;
  let abortReason;
  let responseStarted = false;
  const abort = (reason) => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort();
    // Also release a pending read if a transport does not reject reads on abort.
    void reader?.cancel().catch(() => undefined);
  };
  const cancel = () => abort('cancelled');
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = window.setTimeout(() => abort('timeout'), REQUEST_TIMEOUT_MS);

  try {
    controller.signal.throwIfAborted();
    const headers = await awaitWithAbort(authorizedHeaders(), controller.signal);
    controller.signal.throwIfAborted();
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        history: recentChatHistory(options.history),
        message: options.message,
        rules: options.rules,
        attachmentPath: options.attachmentPath,
      }),
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    responseStarted = true;

    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => null);
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String(payload.error)
          : `Request failed (${response.status})`;
      throw new AiRequestError(message, response.ok ? 502 : response.status);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let result = '';
    let completed = false;
    while (true) {
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) {
        // EOF is not proof of completion, even if some answer text arrived.
        throw new AiRequestError(
          'The AI response ended before it was complete. Please try again.',
          502,
          'incomplete',
        );
      }
      pending += decoder.decode(value, { stream: true });
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop() ?? '';
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        let payload;
        try {
          payload = chatEventSchema.parse(JSON.parse(data));
        } catch {
          throw new AiRequestError(
            'The AI service returned an invalid stream. Please try again.',
            502,
          );
        }
        if (completed) {
          throw new AiRequestError(
            'The AI service returned an invalid stream. Please try again.',
            502,
          );
        }
        if (payload.type === 'delta') {
          result += payload.text;
          options.onDelta?.(result);
        } else if (payload.type === 'error') {
          throw new AiRequestError(
            payload.error || 'The AI request could not be completed.',
            502,
            payload.code || 'failed',
          );
        } else {
          completed = true;
        }
      }
      if (completed) {
        controller.signal.throwIfAborted();
        if (pending.trim() || !result.trim()) {
          throw new AiRequestError(
            'The AI service did not return a complete answer. Please try again.',
            502,
            'incomplete',
          );
        }
        return result;
      }
    }
  } catch (error) {
    if (abortReason === 'cancelled') {
      throw new AiRequestError(
        'Response stopped. No assistant answer was saved.',
        499,
        'cancelled',
      );
    }
    if (abortReason === 'timeout') {
      throw new AiRequestError(
        'The AI took too long to respond. Please try again.',
        504,
        'timeout',
      );
    }
    if (error instanceof AiRequestError) throw error;
    throw new AiRequestError(
      responseStarted
        ? 'The AI connection was interrupted before the answer was complete. Please try again.'
        : 'Could not reach the AI service.',
      responseStarted ? 502 : 0,
      responseStarted ? 'incomplete' : 'failed',
    );
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

/** Preserve both per-candidate citations and the provider's research sources. */
export async function requestPicksWithSources(options, signal) {
  const requestId = options.requestId ?? crypto.randomUUID();
  const result = await post('picks', { ...options, requestId }, picksResponseSchema, signal);
  if (result.analysis.requestId !== requestId)
    throw new AiRequestError('The saved analysis did not match this request.', 502);
  return result;
}

/** GET one page of saved research runs from /api/research/runs (15s timeout), validated by schema. */
export async function requestResearchHistory(signal, cursor) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = window.setTimeout(cancel, 15_000);
  try {
    const headers = await awaitWithAbort(authorizedHeaders(false), controller.signal);
    controller.signal.throwIfAborted();
    const response = await awaitWithAbort(
      fetch(`/api/research/runs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
        headers,
        signal: controller.signal,
      }),
      controller.signal,
    );
    const payload = await awaitWithAbort(
      response.json().catch(() => null),
      controller.signal,
    );
    if (!response.ok)
      throw new AiRequestError(
        'Saved research is unavailable. This browser history is not a cloud backup.',
        response.status,
      );
    const parsed = researchHistoryResponseSchema.safeParse(payload);
    if (!parsed.success) throw new AiRequestError('Saved research could not be verified.', 502);
    return parsed.data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Ask the AI to resolve a free-text query to a symbol; resolves to the symbol or null. */
export async function requestSymbol(query) {
  return (await post('symbol', { query }, symbolResponseSchema)).symbol;
}

/** Ask the AI to draft a trading rule from `draft`; resolves to `{ section, definition, rule }`. */
export async function requestRuleDraft(
  draft,

  signal,
) {
  return post('rule', draft, draftedRuleSchema, signal);
}

/** Ask the AI for written insights on a report; resolves to the text. */
export async function requestInsights(report, signal) {
  return (await post('insights', { report }, textResponseSchema, signal)).text;
}

/** Request the AI briefing; resolves to the validated briefing response. */
export async function requestBriefing(options, signal) {
  return post('briefing', options, briefingResponseSchema, signal);
}

/** Request an AI review of a trade; resolves to the validated review response. */
export async function requestTradeReview(
  options,

  signal,
) {
  return post('review', options, reviewResponseSchema, signal);
}

/** Request AI analysis of an uploaded attachment; resolves to summary, observations, risks and actions. */
export async function requestMaterialAnalysis(
  options,

  signal,
) {
  return post('analyze', options, analyzeResponseSchema, signal);
}

/**
 * Transcribe a voice note (max 10 MB): uploads it to /api/uploads/voice-notes, asks the AI for
 * the transcript, then always tries to delete the upload. Resolves to the transcript text.
 */
export async function requestTranscription(file, signal) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new AiRequestError('Voice notes must be 10 MB or smaller.', 413);
  }
  signal?.throwIfAborted();
  const form = new FormData();
  form.append('file', file, file.name || 'voice-note.webm');
  let uploaded;
  try {
    uploaded = await api('/api/uploads/voice-notes', {
      method: 'POST',
      form,
      signal,
      timeout: 60_000,
    });
  } catch {
    if (signal?.aborted) throw new AiRequestError('Request cancelled.', 499, 'cancelled');
    throw new AiRequestError('Could not securely upload the voice note.', 502);
  }
  const { audioPath, filename, mime } = uploaded;
  try {
    // Never start transcription for a screen that has already gone away.
    signal?.throwIfAborted();
    return (
      await post('transcribe', { audioPath, filename, mime }, transcriptionResponseSchema, signal)
    ).transcript;
  } finally {
    try {
      await api('/api/uploads/voice-notes', { method: 'DELETE', body: { path: audioPath } });
    } catch {
      // The server also attempts cleanup. A failed client cleanup must not
      // replace a completed transcript or the original cancellation outcome.
    }
  }
}

/** Upload an attachment for analysis into the owner's private statements folder. */
export async function uploadStatement(file, signal) {
  const form = new FormData();
  form.append('file', file, file.name);
  const result = await api('/api/uploads/statements', {
    method: 'POST',
    form,
    signal,
    timeout: 60_000,
  });
  return result.path;
}

/** Ask the AI a question about the member's journal; resolves to `{ answer, sources }`. */
export async function requestJournalSearch(query, signal) {
  return post('journal-search', { query }, journalSearchResponseSchema, signal);
}
