/**
 * Sends a question (with optional file or voice-note preparation) and streams
 * the answer.
 */
import {
  AiRequestError,
  awaitWithAbort,
  recentChatHistory,
  requestChat,
  uploadStatement,
} from '../../lib/ai.js';
import { setQuestion } from './input.js';
import { paint, paintStream } from './render.js';
import { addChatMessage, conversationBusy, live, question, state, workspace } from './shared.js';

/**
 * Sends a chat question: saves the user message, uploads any attached document,
 * streams the AI reply into the page and saves it. On failure or Stop, restores the
 * draft and attachment and shows a notice instead of saving an answer.
 */
export async function submit(text) {
  if (live.chat || live.preparation || conversationBusy() || (!text.trim() && !state.selectedFile))
    return;
  const controller = new AbortController();
  live.chat = controller;
  const file = state.selectedFile;
  setQuestion('');
  Object.assign(state, {
    selectedFile: null,
    suggestions: [],
    loading: true,
    savingReply: false,
    streamText: '',
    notice: null,
  });
  paint();

  const history = recentChatHistory(
    state.messages.map((entry) => ({ role: entry.role, text: entry.text })),
  );
  const displayText = text.trim() ? text : 'Analyze this document.';
  let savingReply = false;
  const prepare = (kind, operation) => {
    const current = { controller, kind };
    live.preparation = current;
    const observed = operation.finally(() => {
      if (live.preparation === current) {
        live.preparation = null;
        state.pendingPreparation = null;
        paint();
      }
    });
    return awaitWithAbort(observed, controller.signal);
  };

  try {
    await prepare(
      'message save',
      addChatMessage({
        role: 'user',
        text: displayText + (file ? ' [document attached]' : ''),
        timestamp: new Date().toISOString(),
      }),
    );
    controller.signal.throwIfAborted();
    let attachmentPath = null;
    if (file) attachmentPath = await prepare('document upload', uploadStatement(file));
    controller.signal.throwIfAborted();
    const reply = await requestChat({
      history,
      message: displayText,
      rules: workspace.rules.map((rule) => `${rule.section} — ${rule.rule}`).join('\n'),
      ...(attachmentPath ? { attachmentPath } : {}),
      signal: controller.signal,
      onDelta: (value) => {
        if (live.chat === controller && !controller.signal.aborted) {
          state.streamText = value;
          paintStream();
        }
      },
    });
    controller.signal.throwIfAborted();
    savingReply = true;
    state.savingReply = true;
    paint();
    await addChatMessage({ role: 'assistant', text: reply, timestamp: new Date().toISOString() });
  } catch (error) {
    if (live.chat !== controller) return;
    const cancelled =
      controller.signal.aborted || (error instanceof AiRequestError && error.code === 'cancelled');
    const failure = savingReply
      ? 'The answer was complete, but could not be saved. Please try again.'
      : error instanceof Error
        ? error.message
        : 'The AI request failed. Please try again.';
    if (cancelled && live.preparation?.controller === controller)
      state.pendingPreparation = live.preparation.kind;
    state.notice = {
      cancelled,
      text: cancelled ? 'Response stopped. No assistant answer was saved.' : failure,
    };
    // Keep failed requests out of assistant history and preserve the user's next draft.
    if (!question.value) setQuestion(text);
    if (file && !state.selectedFile) state.selectedFile = file;
  } finally {
    if (live.chat === controller) {
      live.chat = null;
      Object.assign(state, { loading: false, savingReply: false, streamText: '' });
      paint();
    }
  }
}
