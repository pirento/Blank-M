/**
 * Journal page: log a trade, write a strategy note and see recent trades.
 */
import { $, h, pageData, emptyState, formatCurrency, render } from '../core/dom.js';
import { api } from '../core/api.js';
import { notify, notifyError } from '../core/toast.js';
import { isBusinessDate } from '../../../shared/business-dates.js';
import { createTradeForm } from '../components/trade-form.js';

const data = pageData();
const workspace = data.workspace;
const available = Boolean(workspace);
const state = {
  trades: workspace?.trades ?? [],
  strategies: workspace?.strategies ?? [],
};
let pending = false;

function tradeCard(trade) {
  const cell = (term, value) =>
    h(
      'div',
      {},
      h('dt', { class: 'text-subtle' }, term),
      h('dd', { class: 'tnum mt-0.5 text-fg' }, value),
    );
  return h(
    'div',
    { class: 'rounded-card border border-line bg-elevated p-4' },
    h(
      'div',
      { class: 'mb-3 flex items-baseline justify-between gap-3' },
      h(
        'div',
        { class: 'min-w-0 [overflow-wrap:anywhere]' },
        h('span', { class: 'text-sm font-medium text-fg' }, trade.symbol),
        h('span', { class: 'ml-1.5 text-xs text-muted' }, trade.type),
      ),
      h(
        'div',
        { class: `tnum text-sm font-medium ${trade.pnl >= 0 ? 'text-positive' : 'text-negative'}` },
        formatCurrency(trade.pnl),
      ),
    ),
    h(
      'dl',
      {
        class:
          'grid grid-cols-2 gap-2 border-y border-line py-2.5 text-xs [overflow-wrap:anywhere] sm:grid-cols-4',
      },
      cell('Entry', String(trade.entryPrice)),
      cell('Exit', String(trade.exitPrice)),
      cell('Qty', String(trade.quantity)),
      cell('Charges', formatCurrency(trade.charges)),
    ),
    trade.notes
      ? h(
          'p',
          {
            class:
              'mt-3 border-l-2 border-line-strong pl-3 text-sm leading-relaxed whitespace-pre-wrap text-muted [overflow-wrap:anywhere]',
          },
          trade.notes,
        )
      : null,
  );
}

function strategyCard(strategy) {
  return h(
    'div',
    { class: 'border border-line bg-elevated p-4' },
    h(
      'div',
      { class: 'mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2' },
      h('div', { class: 'min-w-0 text-lg text-fg [overflow-wrap:anywhere]' }, strategy.name),
      h('div', { class: 'shrink-0 tnum text-xs text-muted' }, strategy.date),
    ),
    h(
      'p',
      { class: 'text-xs leading-relaxed whitespace-pre-line text-muted [overflow-wrap:anywhere]' },
      strategy.rules,
    ),
  );
}

function paintLists() {
  render(
    $('[data-recent-trades]'),
    !available
      ? h(
          'p',
          { class: 'text-sm text-muted' },
          'Recent trades are unavailable while account data loads.',
        )
      : state.trades.length === 0
        ? emptyState({ title: 'No trades recorded yet', hint: 'Log your first trade above' })
        : h('div', { class: 'space-y-4' }, state.trades.map(tradeCard)),
  );
  render(
    $('[data-strategy-logs]'),
    !available
      ? h(
          'p',
          { class: 'text-sm text-muted' },
          'Strategy logs are unavailable while account data loads.',
        )
      : state.strategies.length === 0
        ? emptyState({ title: 'No strategies yet', hint: 'Add your first one' })
        : h('div', { class: 'space-y-4' }, state.strategies.slice(0, 5).map(strategyCard)),
  );
}

function mountTradeForm() {
  render(
    $('[data-trade-form]'),
    createTradeForm({
      strategies: state.strategies,
      settings: workspace?.settings ?? { charges: { enabled: false } },
      available,
      onSubmitted: (trade) => {
        notify('Trade logged.', 'success');
        state.trades = [trade, ...state.trades].sort(
          (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
        );
        mountTradeForm();
        paintLists();
      },
    }),
  );
}

const strategyForm = $('[data-strategy-form]');
const strategyError = $('[data-strategy-error]');
const setStrategyError = (message) => {
  strategyError.textContent = message;
  strategyError.hidden = !message;
};

strategyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pending || !available) return;
  setStrategyError('');
  const values = Object.fromEntries(new FormData(strategyForm));
  const name = values.name.trim();
  const rules = values.rules.trim();
  if (name.length < 3 || name.length > 120) {
    setStrategyError('Strategy name must be between 3 and 120 characters long.');
    return;
  }
  if (!isBusinessDate(values.date)) {
    setStrategyError('Choose a valid strategy date.');
    return;
  }
  if (rules.length < 10) {
    setStrategyError('Rules must be at least 10 characters long.');
    return;
  }
  pending = true;
  const fieldset = strategyForm.querySelector('fieldset');
  const submit = strategyForm.querySelector('[type="submit"]');
  fieldset.disabled = true;
  submit.textContent = 'Saving…';
  try {
    const result = await api('/api/strategies', {
      method: 'POST',
      body: {
        date: values.date,
        name,
        rules,
        improvements: values.improvements,
        notes: values.notes,
      },
    });
    state.strategies = [result.strategy, ...state.strategies];
    for (const key of ['name', 'rules', 'improvements', 'notes'])
      strategyForm.elements[key].value = '';
    notify('Strategy saved.', 'success');
    paintLists();
    // The trade form's strategy picker must list the new strategy.
    mountTradeForm();
  } catch (error) {
    notifyError(error, 'Could not save the strategy.');
  } finally {
    pending = false;
    fieldset.disabled = false;
    submit.textContent = 'Save strategy';
  }
});

mountTradeForm();
paintLists();
