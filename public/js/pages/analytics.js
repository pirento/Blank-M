/**
 * Analytics page: chat grounded in the owner's trading record. Requests are
 * serialised: the conversation, structured analyses and clearing never overlap,
 * and a cancelled response is never saved as an assistant answer.
 *
 * The page is split into public/js/pages/analytics/; this entry wires the
 * question box, attachments, voice notes, chat and generator forms and journal
 * search (in the original order) and paints the page.
 */
import { $, $$, h, render } from '../core/dom.js';
import { notify, notifyError } from '../core/toast.js';
import {
  MAX_ATTACHMENT_BYTES,
  awaitWithAbort,
  requestJournalSearch,
  requestTranscription,
} from '../lib/ai.js';
import { markdown } from '../components/markdown.js';
import {
  TRADING_TERMS,
  attachmentInput,
  beginAuxiliary,
  conversationBusy,
  currentAuxiliary,
  endAuxiliary,
  live,
  question,
  state,
  voiceInput,
} from './analytics/shared.js';
import { paint, paintMessages } from './analytics/render.js';
import { applySuggestion, setQuestion } from './analytics/input.js';
import { submit } from './analytics/chat.js';

question?.addEventListener('input', () => {
  const value = question.value;
  setQuestion(value);
  const lastWord = value.split(/[\s,]+/).at(-1) ?? '';
  state.suggestions =
    lastWord.length >= 2
      ? TRADING_TERMS.filter((term) => term.toLowerCase().startsWith(lastWord.toLowerCase()))
      : [];
  state.focusedSuggestion = 0;
  paint();
});

question?.addEventListener('keydown', (event) => {
  if (state.suggestions.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.focusedSuggestion = Math.min(state.focusedSuggestion + 1, state.suggestions.length - 1);
      paint();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.focusedSuggestion = Math.max(state.focusedSuggestion - 1, 0);
      paint();
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const choice = state.suggestions[state.focusedSuggestion];
      if (choice) applySuggestion(choice);
      return;
    }
    if (event.key === 'Escape') {
      state.suggestions = [];
      paint();
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void submit(question.value);
  }
});

for (const prompt of $$('[data-prompt]')) {
  prompt.addEventListener('click', () => {
    if (!question) return;
    setQuestion(prompt.dataset.prompt);
    state.suggestions = [];
    paint();
    question.focus();
  });
}

attachmentInput?.addEventListener('change', () => {
  const file = attachmentInput.files?.[0];
  attachmentInput.value = '';
  if (!file) return;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    notify(
      `That file is too large. Attachments must be under ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`,
      'error',
    );
    return;
  }
  state.selectedFile = file;
  paint();
});

voiceInput?.addEventListener('change', async () => {
  const file = voiceInput.files?.[0];
  voiceInput.value = '';
  if (!file) return;
  const controller = beginAuxiliary('voice');
  if (!controller) return;
  state.voiceLoading = true;
  paint();
  try {
    const transcript = await awaitWithAbort(
      requestTranscription(file, controller.signal),
      controller.signal,
    );
    if (!currentAuxiliary('voice', controller)) return;
    setQuestion(`${question.value}${question.value ? '\n' : ''}${transcript}`);
    notify('Voice note transcribed. Review it before sending or saving.', 'success');
  } catch (error) {
    if (currentAuxiliary('voice', controller))
      notifyError(error, 'Could not transcribe the voice note.');
  } finally {
    endAuxiliary('voice', controller, 'voiceLoading');
  }
});

$('[data-chat-form]')?.addEventListener('submit', (event) => {
  event.preventDefault();
  void submit(question.value);
});

const generatorForm = $('[data-generator-form]');
generatorForm?.addEventListener('input', paint);
generatorForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = generatorForm.elements.name.value;
  const concept = generatorForm.elements.concept.value;
  const constraints = generatorForm.elements.constraints.value;
  if (live.chat || live.preparation || conversationBusy() || !name.trim() || !concept.trim())
    return;
  const prompt = `Generate a detailed trading strategy named "${name}".

Core concept and rules:
${concept}

Constraints and additional information:
${constraints || 'None'}

Provide a structured breakdown covering:
1. Strategy overview
2. Entry criteria
3. Exit criteria (stop loss and take profit)
4. Risk management rules
5. Weaknesses and edge cases`;
  generatorForm.reset();
  await submit(prompt);
});

$('[data-search-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('[data-search-query]').value.trim();
  if (!query) return;
  const controller = beginAuxiliary('search');
  if (!controller) return;
  state.searchLoading = true;
  render($('[data-search-result]'));
  paint();
  try {
    const result = await awaitWithAbort(
      requestJournalSearch(query, controller.signal),
      controller.signal,
    );
    if (!currentAuxiliary('search', controller)) return;
    const sources = result.sources.map((source) => source.title);
    render(
      $('[data-search-result]'),
      result.answer
        ? h(
            'div',
            { class: 'mt-4 rounded-card border border-line bg-elevated p-3' },
            markdown(result.answer),
            sources.length
              ? h(
                  'p',
                  { class: 'mt-3 border-t border-line pt-3 text-xs text-subtle' },
                  `Sources: ${sources.join(' · ')}`,
                )
              : null,
          )
        : null,
    );
  } catch (error) {
    if (currentAuxiliary('search', controller))
      notifyError(error, 'Could not search your journal.');
  } finally {
    endAuxiliary('search', controller, 'searchLoading');
  }
});

paintMessages();
paint();
