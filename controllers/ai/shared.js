/**
 * Helpers shared by the AI handlers: upload limits and checks, SSE framing,
 * chat history trimming, safe error responses and statement attachments.
 */
import { ResearchUniverseError } from '../../services/ai/research-universe.js';
import { ResearchArchiveError } from '../../services/ai/research-archive.js';
import { z } from 'zod';
import { isSafeOwnerStoragePath } from '../../services/storage-path.js';
import { downloadObject } from '../../services/storage.js';
import { ChatStreamFailure, statusOf } from '../../services/ai/openai.js';
import { createLogger, errorName } from '../../services/logger.js';

const log = createLogger('ai');

const MAX_HISTORY_TURNS = 20;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg']);
export const ALLOWED_AUDIO_MIME = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'audio/x-m4a',
]);

/** Throws 403 unless the storage path belongs to this member. */
export function assertAttachmentOwnership(path, userId) {
  if (!isSafeOwnerStoragePath(path, userId)) {
    throw Object.assign(new Error('You can only analyze files from your own workspace.'), {
      status: 403,
    });
  }
}

/** Throws 415 for anything but PDF, PNG or JPEG and 413 above 10 MB. */
export function assertAttachmentFile(mime, byteLength) {
  if (!ALLOWED_MIME.has(mime)) {
    throw Object.assign(new Error('Only PDF, PNG, and JPEG statements are supported.'), {
      status: 415,
    });
  }
  if (byteLength > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(new Error('The statement must be 10 MB or smaller.'), { status: 413 });
  }
}

/** Frames one server-sent event. */
export function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The last `maxTurns` turns, starting at the first user turn (empty when there is none). */
export function trimHistory(history, maxTurns = MAX_HISTORY_TURNS) {
  const recent = history.slice(-maxTurns);
  const firstUser = recent.findIndex((turn) => turn.role === 'user');
  return firstUser === -1 ? [] : recent.slice(firstUser);
}

/**
 * Error text that is safe to show: our own messages and 4xx errors pass through,
 * provider and server errors become a generic message.
 */
export function safeFailureMessage(error) {
  if (
    error instanceof ChatStreamFailure ||
    error instanceof ResearchUniverseError ||
    error instanceof ResearchArchiveError
  )
    return error.message;
  const status = statusOf(error);
  if (error instanceof z.ZodError)
    return `Invalid request: ${error.issues[0]?.message || 'bad payload'}`;
  return status < 500 && error instanceof Error
    ? error.message
    : status === 503
      ? 'This integration is not configured yet.'
      : 'The AI request could not be completed. Please try again.';
}

/** Sends the error as JSON with its status; 5xx errors are logged. */
export function handleFailure(res, error) {
  const status = statusOf(error);
  if (status >= 500) log.error('request failed', { status, error: errorName(error) });
  res.status(status).json({ error: safeFailureMessage(error) });
}

/**
 * Loads a member's uploaded statement as an OpenAI input part: input_file for a PDF,
 * input_image otherwise. 403 for another member's path, 404 when it cannot be read.
 */
export async function attachmentInput(path, userId) {
  assertAttachmentOwnership(path, userId);
  const data = await downloadObject('statements', path);
  if (!data)
    throw Object.assign(new Error('The uploaded file could not be read.'), { status: 404 });
  const bytes = data.buffer;
  assertAttachmentFile(data.contentType, bytes.byteLength);
  const dataUrl = `data:${data.contentType};base64,${bytes.toString('base64')}`;
  return data.contentType === 'application/pdf'
    ? {
        type: 'input_file',
        filename: path.split('/').at(-1) || 'statement.pdf',
        file_data: dataUrl,
      }
    : { type: 'input_image', image_url: dataUrl, detail: 'auto' };
}
