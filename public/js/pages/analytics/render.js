/**
 * Renders the conversation, the streaming answer and the side panels.
 */
import { $, h, icon, button, render } from '../../core/dom.js';
import { markdown } from '../../components/markdown.js';
import { applySuggestion } from './input.js';
import { aiReady, attachmentInput, live, question, state, voiceInput } from './shared.js';
import { analyzeSelectedFile, clearConversation, runTradeReview } from './tools.js';

/** Renders the saved chat messages (assistant replies as markdown) and scrolls to the end. */
export function paintMessages() {
  render(
    $('[data-message-list]'),
    state.messages.map((message) =>
      h(
        'div',
        { class: 'chat-reference-message', 'data-role': message.role },
        h('small', {}, message.role === 'user' ? 'You' : 'Research assistant'),
        message.role === 'assistant'
          ? markdown(message.text)
          : h('div', { class: 'whitespace-pre-wrap' }, message.text),
      ),
    ),
  );
  $('[data-messages-end]').scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/** Renders the in-progress assistant reply: streamed text so far, or a typing indicator. */
export function paintStream() {
  render(
    $('[data-stream]'),
    state.loading
      ? h(
          'div',
          { class: 'flex w-full justify-start' },
          h(
            'div',
            { class: 'flex max-w-[85%] flex-row gap-3' },
            h(
              'div',
              {
                class:
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fg text-surface shadow-md',
              },
              icon('bot', 16),
            ),
            h(
              'div',
              {
                class:
                  'min-h-[52px] rounded-2xl rounded-tl-sm border border-line bg-surface px-5 py-4 text-sm leading-relaxed text-muted shadow-sm',
              },
              h(
                'p',
                { class: 'mb-2 text-xs text-subtle' },
                state.savingReply
                  ? 'Saving completed answer…'
                  : 'Generating response · not saved yet',
              ),
              state.streamText
                ? markdown(state.streamText)
                : h(
                    'span',
                    {
                      class: 'inline-flex items-center gap-1.5',
                      'aria-label': 'OpenAI is thinking',
                    },
                    [0, 0.15, 0.3].map((delay) =>
                      h('span', {
                        class: 'h-1.5 w-1.5 animate-bounce rounded-full bg-muted',
                        style: { animationDelay: `${delay}s` },
                      }),
                    ),
                  ),
            ),
          ),
        )
      : null,
  );
  render(
    $('[data-chat-notice]'),
    state.notice
      ? h(
          'p',
          {
            role: state.notice.cancelled ? 'status' : 'alert',
            class: 'rounded-control border border-line bg-elevated p-3 text-sm text-muted',
          },
          state.notice.text,
        )
      : null,
  );
}

/**
 * Repaints the chat controls from `state`: header actions, stream, attachment chip,
 * suggestions, send/stop button, pending-preparation notice and file analysis bar.
 * Buttons are disabled while any request is in flight.
 */
export function paint() {
  const blocked =
    state.clearing ||
    state.materialLoading ||
    state.reviewLoading ||
    state.loading ||
    Boolean(state.pendingPreparation);
  render(
    $('[data-chat-actions]'),
    button(
      [icon('bar-chart-3', 14, 'mr-2'), state.reviewLoading ? 'Reviewing…' : 'Review trades'],
      {
        variant: 'outline',
        size: 'sm',
        disabled: !aiReady || blocked,
        onclick: () => void runTradeReview(),
      },
    ),
    state.messages.length > 0
      ? button(icon('trash-2', 14), {
          variant: 'ghost',
          size: 'sm',
          'aria-label': 'Clear conversation',
          disabled: blocked,
          onclick: () => void clearConversation(),
        })
      : null,
  );
  paintStream();
  if (!question) return;

  render(
    $('[data-attached]'),
    state.selectedFile
      ? h(
          'div',
          {
            class:
              'mx-1 mb-2 flex max-w-full items-center gap-2 rounded bg-surface px-2 py-1 tnum text-xs',
          },
          h('span', { class: 'min-w-0 truncate' }, `Attached: ${state.selectedFile.name}`),
          button('Remove', {
            variant: 'ghost',
            size: 'sm',
            'aria-label': 'Remove attachment',
            onclick: () => {
              state.selectedFile = null;
              attachmentInput.value = '';
              paint();
            },
          }),
        )
      : null,
  );

  const list = $('[data-suggestions]');
  list.hidden = state.suggestions.length === 0;
  render(
    list,
    state.suggestions.map((suggestion, index) =>
      h(
        'li',
        { role: 'presentation' },
        h(
          'button',
          {
            id: `chat-suggestions-${index}`,
            role: 'option',
            'aria-selected': String(index === state.focusedSuggestion),
            type: 'button',
            class: `w-full px-4 py-2 text-left text-sm ${index === state.focusedSuggestion ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-elevated'}`,
            onclick: () => applySuggestion(suggestion),
          },
          suggestion,
        ),
      ),
    ),
  );
  if (state.suggestions.length) {
    question.setAttribute('aria-controls', 'chat-suggestions');
    question.setAttribute('aria-activedescendant', `chat-suggestions-${state.focusedSuggestion}`);
  } else {
    question.removeAttribute('aria-controls');
    question.removeAttribute('aria-activedescendant');
  }
  voiceInput.disabled = state.voiceLoading;

  render(
    $('[data-send-slot]'),
    state.loading
      ? button(
          [
            icon('square', 16, 'md:mr-2'),
            h('span', { class: 'hidden md:inline' }, state.savingReply ? 'Saving…' : 'Stop'),
          ],
          {
            variant: 'outline',
            className: 'h-[52px] shrink-0 px-6',
            disabled: state.savingReply,
            'aria-label': 'Stop response',
            onclick: () => live.chat?.abort(),
          },
        )
      : button([icon('send', 16, 'md:mr-2'), h('span', { class: 'hidden md:inline' }, 'Send')], {
          type: 'submit',
          'aria-label': 'Send',
          className: 'h-[52px] shrink-0 px-6',
          disabled:
            state.materialLoading ||
            state.reviewLoading ||
            state.clearing ||
            Boolean(state.pendingPreparation) ||
            (!question.value.trim() && !state.selectedFile),
        }),
  );
  render(
    $('[data-preparation]'),
    state.pendingPreparation
      ? h(
          'p',
          { role: 'status', class: 'mt-2 text-sm text-muted' },
          `The earlier ${state.pendingPreparation} is still pending and may finish. Sending is paused to avoid duplicate work.`,
        )
      : null,
  );
  render(
    $('[data-material]'),
    state.selectedFile
      ? h(
          'div',
          {
            class:
              'mt-2 flex items-center justify-between gap-3 rounded-control border border-line bg-elevated px-3 py-2',
          },
          h(
            'p',
            { class: 'min-w-0 truncate text-xs text-muted' },
            'Use chat for an open review, or run a structured statement/chart analysis.',
          ),
          button(
            [
              icon('file-scan', 14, 'mr-2'),
              state.materialLoading ? 'Analyzing…' : 'Structured analysis',
            ],
            {
              size: 'sm',
              variant: 'outline',
              disabled: blocked,
              onclick: () => void analyzeSelectedFile(),
            },
          ),
        )
      : null,
  );
  const generate = $('[data-generate]');
  if (generate) {
    const form = $('[data-generator-form]');
    generate.disabled =
      blocked || !form.elements.name.value.trim() || !form.elements.concept.value.trim();
  }
  const searchSubmit = $('[data-search-submit]');
  if (searchSubmit) {
    searchSubmit.disabled = state.searchLoading;
    $('[data-search-query]').disabled = state.searchLoading;
    render(
      searchSubmit,
      icon('sparkles', 14, 'mr-2'),
      state.searchLoading ? 'Searching…' : 'Search privately',
    );
  }
}
