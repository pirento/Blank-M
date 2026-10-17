/**
 * Getting-started checklist (can be dismissed; remembered in localStorage).
 */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  icon,
  cn,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  render,
} from '../../core/dom.js';
import { CHECKLIST_DISMISSED_KEY, rules, settings, trades, watchlist } from './shared.js';

/**
 * Renders the "Finish setting up" checklist of incomplete onboarding steps. Hidden once
 * every step is done or the user dismissed it (dismissal kept in localStorage).
 */
export function paintChecklist() {
  const container = $('[data-checklist]');
  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem(CHECKLIST_DISMISSED_KEY) === 'true';
  } catch {
    dismissed = false;
  }
  const steps = [
    { label: 'Set your opening balance', to: '/settings', done: settings.openingBalance > 0 },
    { label: 'Write at least one rule', to: '/rules', done: rules.length > 0 },
    { label: 'Log your first trade', to: '/journal', done: trades.length > 0 },
    { label: 'Add a symbol to your watchlist', to: '/watchlist', done: watchlist.length > 0 },
  ];
  const remaining = steps.filter((step) => !step.done);
  if (dismissed || remaining.length === 0) {
    render(container);
    return;
  }
  const dismiss = () => {
    try {
      window.localStorage.setItem(CHECKLIST_DISMISSED_KEY, 'true');
    } catch {
      // Not persisting a dismissal is a smaller problem than failing here.
    }
    render(container);
  };
  render(
    container,
    card(
      {},
      cardHeader(
        '',
        h(
          'div',
          {},
          cardTitle(t('Finish setting up')),
          h(
            'p',
            { class: 'mt-0.5 text-xs text-muted' },
            `${steps.length - remaining.length} of ${steps.length} done`,
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            onclick: dismiss,
            'aria-label': t('Dismiss the setup checklist'),
            class: 'focus-ring rounded-control p-1.5 text-muted hover:bg-elevated hover:text-fg',
          },
          icon('x', 15),
        ),
      ),
      cardContent(
        '',
        h(
          'ul',
          { class: 'grid gap-2 sm:grid-cols-2' },
          steps.map((step) =>
            h(
              'li',
              {},
              h(
                'a',
                {
                  href: step.to,
                  class: cn(
                    'focus-ring flex items-center gap-2.5 rounded-control border border-line px-3 py-2 text-sm transition-colors hover:bg-elevated',
                    step.done && 'text-subtle',
                  ),
                },
                h(
                  'span',
                  {
                    class: cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                      step.done ? 'border-positive bg-positive text-white' : 'border-line-strong',
                    ),
                  },
                  step.done ? icon('check', 11) : null,
                ),
                h('span', { class: cn(step.done && 'line-through') }, step.label),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
