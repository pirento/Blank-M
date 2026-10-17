/**
 * Position calculator: manual position planning. Every estimate comes from
 * shared/risk-calculator.js using exact decimal arithmetic; saving freezes the
 * inputs and estimate as an order plan.
 *
 * The page is split into public/js/pages/calculator/; this entry mounts the
 * calculator (or the empty-watchlist prompt), creates the plan store and paints.
 */
import { $, h, icon, buttonClass, render } from '../core/dom.js';
import { NSE_SYMBOL_RE } from '../../../shared/ai-schemas.js';
import { createOrderPlanStore } from '../lib/order-plans-store.js';
import { accountId, requestedSymbol, storeRef, watchlist } from './calculator/shared.js';
import { loadQuote } from './calculator/quotes.js';
import { calculator } from './calculator/layout.js';
import { paintEstimate, paintModes, paintQuote, paintSync } from './calculator/painting.js';

const emptyWatchlist = watchlist.length === 0 && !NSE_SYMBOL_RE.test(requestedSymbol);
const root = $('[data-calculator-root]');
if (emptyWatchlist) {
  $('[data-calculator-description]').textContent =
    'Position size, stop and target — in one calculation.';
  render(
    root,
    h(
      'div',
      { class: 'rounded-card border border-line bg-surface px-6 py-[58px] text-center' },
      h('h2', { class: 'mb-[11px] text-[23px] tracking-[-0.6px]' }, 'Choose an instrument first'),
      h(
        'p',
        { class: 'mb-[22px] text-sm leading-relaxed text-muted' },
        'Add an instrument to your watchlist to begin.',
      ),
      h(
        'a',
        { class: buttonClass(), href: '/today' },
        'Open Today',
        icon('arrow-right', 14, 'ml-2'),
      ),
    ),
    h(
      'details',
      { class: 'mt-6' },
      h(
        'summary',
        { class: 'focus-ring cursor-pointer text-sm text-muted' },
        'Enter an instrument manually',
      ),
      h('div', { class: 'mt-5' }, calculator),
    ),
  );
} else {
  render(root, calculator);
}
storeRef.current = createOrderPlanStore(accountId, () => {
  if (storeRef.current) paintEstimate();
});
paintModes();
paintQuote();
paintSync();
paintEstimate();
void loadQuote();
