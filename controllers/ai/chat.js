/**
 * POST /api/ai/chat: the streaming trading-coach chat. Saves both turns and
 * reads an optional uploaded statement (PDF or image) owned by the member.
 */
import { readJsonBody, requireMethod } from '../../services/http.js';
import { authenticateRequest } from '../../services/auth/request-auth.js';
import { enforceAiRateLimit, recordAiUsage } from '../../services/ai/usage-limits.js';
import { resolveAiConfig } from '../../services/ai/config.js';
import { chatRequestSchema } from '../../shared/ai-schemas.js';
import {
  attachmentInput,
  handleFailure,
  safeFailureMessage,
  sseData,
  trimHistory,
} from './shared.js';
import {
  ANALYSIS_MODEL,
  ChatStreamFailure,
  openAiClient,
  providerRequest,
  providerStream,
} from '../../services/ai/openai.js';

/**
 * POST /api/ai/chat: streams the coach's reply as server-sent events (delta, done, error).
 * Stops generation when the client disconnects and records AI usage for every outcome.
 */
export async function handleChat(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  let userId = '';
  let model = ANALYSIS_MODEL;
  let outcome = 'failed';
  let usage;
  let requestId;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const onResponseClose = () => {
    // IncomingMessage.close also fires after a normally consumed request body.
    // Only an aborted request or prematurely closed response cancels generation.
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', onResponseClose);
  if (req.aborted || res.destroyed) abort();
  try {
    controller.signal.throwIfAborted();
    const auth = await authenticateRequest(req);
    // Invalid or limited requests do no AI work, so they are not recorded as usage.
    const body = chatRequestSchema.parse(readJsonBody(req));
    await enforceAiRateLimit(auth.user.id);
    userId = auth.user.id;
    if (!body.message.trim() && !body.attachmentPath) {
      throw Object.assign(new Error('Provide a message or statement to analyze.'), { status: 400 });
    }

    const finalContent = [];
    if (body.attachmentPath) finalContent.push(await attachmentInput(body.attachmentPath, userId));
    finalContent.push({
      type: 'input_text',
      text: body.message.trim() || 'Analyze this statement and identify risk-management patterns.',
    });

    const input = [
      ...trimHistory(body.history).map((turn) => ({
        role: turn.role,
        content: [{ type: 'input_text', text: turn.text }],
      })),
      { role: 'user', content: finalContent },
    ];
    const constitution = body.rules?.trim()
      ? `\n\nThe user's binding trading constitution:\n${body.rules}`
      : '';
    const { analysisModel } = await resolveAiConfig();
    model = analysisModel;
    controller.signal.throwIfAborted();
    const client = openAiClient();
    const stream = await providerRequest(() =>
      client.responses.create(
        {
          model: analysisModel,
          store: false,
          stream: true,
          instructions:
            'You are Blank, a rigorous quantitative trading-journal analyst. Analyze completed trades, ' +
            'statements, strategies, and risk. Use concrete metrics, identify rule violations, state ' +
            'uncertainty, and never present output as personalized investment advice.' +
            constitution,
          input: input,
        },
        // Not retried: a timed-out request may already have been run and billed.
        { signal: controller.signal, maxRetries: 0 },
      ),
    );
    controller.signal.throwIfAborted();

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let completed = false;
    for await (const event of providerStream(stream)) {
      controller.signal.throwIfAborted();
      if (event.type === 'response.output_text.delta') {
        res.write(sseData({ type: 'delta', text: event.delta }));
      } else if (event.type === 'response.completed') {
        if (event.response.status !== 'completed') {
          throw new ChatStreamFailure('incomplete');
        }
        completed = true;
        usage = event.response.usage ?? undefined;
        requestId = event.response.id;
      } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
        usage = event.response.usage ?? undefined;
        requestId = event.response.id;
        throw new ChatStreamFailure(event.type === 'response.failed' ? 'failed' : 'incomplete');
      } else if (event.type === 'error') {
        // Provider diagnostics can contain private details; send only our safe message.
        throw new ChatStreamFailure('failed');
      }
    }
    controller.signal.throwIfAborted();
    if (!completed) throw new ChatStreamFailure('incomplete');
    res.write(sseData({ type: 'done' }));
    res.end();
    outcome = 'completed';
  } catch (error) {
    outcome = controller.signal.aborted
      ? 'cancelled'
      : error instanceof ChatStreamFailure
        ? error.code
        : 'failed';
    if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) {
      if (!res.headersSent) handleFailure(res, error);
      else {
        res.write(sseData({ type: 'error', code: outcome, error: safeFailureMessage(error) }));
        res.end();
      }
    }
  } finally {
    req.off('aborted', abort);
    res.off('close', onResponseClose);
    if (userId) {
      await recordAiUsage({
        userId,
        feature: 'chat',
        model,
        status: outcome,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        requestId,
      }).catch(() => undefined);
    }
  }
}
