/**
 * Structured tools that post into the conversation: file analysis, trade review
 * and clearing the conversation.
 */
import { api } from '../../core/api.js';
import { notify, notifyError } from '../../core/toast.js';
import {
  awaitWithAbort,
  requestMaterialAnalysis,
  requestTradeReview,
  uploadStatement,
} from '../../lib/ai.js';
import { setQuestion } from './input.js';
import { paint, paintMessages } from './render.js';
import {
  addChatMessage,
  beginAuxiliary,
  currentAuxiliary,
  endAuxiliary,
  question,
  state,
  workspace,
} from './shared.js';

const bullets = (items) => items.map((item) => `- ${item}`).join('\n');

/**
 * Uploads the attached file and asks the AI for a structured statement (PDF) or chart
 * analysis, then saves the request and the formatted result as chat messages.
 */
export async function analyzeSelectedFile() {
  if (!state.selectedFile) return;
  const controller = beginAuxiliary('material');
  if (!controller) return;
  const file = state.selectedFile;
  const draft = question.value;
  state.materialLoading = true;
  paint();
  try {
    const attachmentPath = await awaitWithAbort(
      uploadStatement(file, controller.signal),
      controller.signal,
    );
    if (!currentAuxiliary('material', controller)) return;
    const kind = file.type === 'application/pdf' ? 'statement' : 'chart';
    const result = await awaitWithAbort(
      requestMaterialAnalysis({ attachmentPath, kind, context: draft.trim() }, controller.signal),
      controller.signal,
    );
    if (!currentAuxiliary('material', controller)) return;
    await awaitWithAbort(
      addChatMessage({
        role: 'user',
        text: `Analyze ${kind}: ${file.name}`,
        timestamp: new Date().toISOString(),
      }),
      controller.signal,
    );
    if (!currentAuxiliary('material', controller)) return;
    await awaitWithAbort(
      addChatMessage({
        role: 'assistant',
        text: `## Summary\n${result.summary}\n\n## Observations\n${bullets(result.observations)}\n\n## Risks\n${bullets(result.risks)}\n\n## Next actions\n${bullets(result.actions)}`,
        timestamp: new Date().toISOString(),
      }),
      controller.signal,
    );
    if (!currentAuxiliary('material', controller)) return;
    if (state.selectedFile === file) state.selectedFile = null;
    if (question.value === draft) setQuestion('');
  } catch (error) {
    if (currentAuxiliary('material', controller))
      notifyError(error, 'Could not analyze the material.');
  } finally {
    endAuxiliary('material', controller, 'materialLoading');
  }
}

/**
 * Sends up to 100 recent trades and the trading rules for an AI review, then saves the
 * request and the formatted review as chat messages. Needs at least one logged trade.
 */
export async function runTradeReview() {
  if (!workspace.trades.length) {
    notify('Log at least one completed trade before running a review.', 'error');
    return;
  }
  const controller = beginAuxiliary('review');
  if (!controller) return;
  state.reviewLoading = true;
  paint();
  try {
    const result = await awaitWithAbort(
      requestTradeReview(
        {
          trades: JSON.stringify(workspace.trades.slice(0, 100)),
          rules: workspace.rules.map((rule) => `${rule.section}: ${rule.rule}`).join('\n'),
          context:
            'Review the most recent completed trades and prioritize repeatable process changes.',
        },
        controller.signal,
      ),
      controller.signal,
    );
    if (!currentAuxiliary('review', controller)) return;
    await awaitWithAbort(
      addChatMessage({
        role: 'user',
        text: 'Review my recent completed trades against my trading constitution.',
        timestamp: new Date().toISOString(),
      }),
      controller.signal,
    );
    if (!currentAuxiliary('review', controller)) return;
    await awaitWithAbort(
      addChatMessage({
        role: 'assistant',
        text: `## Review\n${result.summary}\n\n## Strengths\n${bullets(result.strengths)}\n\n## Risks\n${bullets(result.risks)}\n\n## Rule adherence\n${bullets(result.ruleAdherence)}\n\n## Next actions\n${bullets(result.nextActions)}`,
        timestamp: new Date().toISOString(),
      }),
      controller.signal,
    );
  } catch (error) {
    if (currentAuxiliary('review', controller))
      notifyError(error, 'Could not review recent trades.');
  } finally {
    endAuxiliary('review', controller, 'reviewLoading');
  }
}

/** Deletes all chat messages via DELETE /api/chat/messages and empties the list. */
export async function clearConversation() {
  const controller = beginAuxiliary('clear');
  if (!controller) return;
  state.clearing = true;
  paint();
  try {
    await awaitWithAbort(api('/api/chat/messages', { method: 'DELETE' }), controller.signal);
    state.messages = [];
    paintMessages();
  } catch (error) {
    if (currentAuxiliary('clear', controller))
      notifyError(error, 'Could not clear the conversation.');
  } finally {
    endAuxiliary('clear', controller, 'clearing');
  }
}
