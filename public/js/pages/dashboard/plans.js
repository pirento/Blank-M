/**
 * Recent order plans from the local/cloud plan store.
 */
import { t } from '../../core/i18n.js';
import { $, h, icon, formatCurrency, render } from '../../core/dom.js';

/** Renders the plan counts and a table of the three newest prepared plans, or an empty/error state. */
export function paintPlans({ plans, error }) {
  $('[data-plan-count]').textContent = error ? '—' : String(plans.length).padStart(2, '0');
  $('[data-recent-count]').textContent = error ? '—' : String(plans.length);
  const container = $('[data-recent-plans]');
  if (error) {
    render(container, h('p', { role: 'alert', class: 'my-5 text-sm text-negative' }, error));
    return;
  }
  const recent = [...plans]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 3);
  if (!recent.length) {
    render(
      container,
      h(
        'div',
        { class: 'reference-plans-empty' },
        h(
          'div',
          {},
          icon('arrow-right-left', 19),
          h('h3', {}, 'No prepared plans yet.'),
          h('p', {}, 'Start with a watchlist instrument, then calculate your position.'),
        ),
        h(
          'a',
          { href: '/calculator', class: 'focus-ring reference-text-link' },
          'Open calculator ',
          icon('arrow-right', 14),
        ),
      ),
    );
    return;
  }
  render(
    container,
    h(
      'div',
      { class: 'reference-table-scroll' },
      h(
        'table',
        { class: 'reference-stock-table', 'aria-label': t('Prepared plans, not executions') },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ['Instrument', 'Side', 'Qty', 'Entry', 'Status'].map((label) =>
              h('th', { scope: 'col' }, label),
            ),
          ),
        ),
        h(
          'tbody',
          {},
          recent.map((plan) =>
            h(
              'tr',
              {},
              h(
                'th',
                { scope: 'row' },
                plan.symbol,
                h('small', {}, plan.strategySnapshot?.name || 'Manual research plan'),
              ),
              h('td', {}, plan.direction === 'Long' ? 'BUY' : 'SELL'),
              h('td', { class: 'font-mono' }, String(plan.estimate.quantity)),
              h('td', { class: 'font-mono' }, formatCurrency(Number(plan.inputs.entryPrice))),
              h(
                'td',
                {},
                h(
                  'span',
                  { class: 'reference-pill reference-pill-outline' },
                  plan.reviewedAt ? 'Reviewed plan' : 'Local plan',
                ),
                h('small', {}, 'Not submitted'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
