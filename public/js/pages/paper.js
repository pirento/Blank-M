/**
 * Paper trading page: start a simulated trade at the live price, watch open
 * trades (prices are re-checked every 30 seconds while the page is open) and
 * review closed ones. Nothing here sends an order.
 */
import { signedCurrency as signed, pnlTone as tone } from '../core/format.js';
import { t } from '../core/i18n.js';
import {
  $,
  h,
  cn,
  pageData,
  button,
  input,
  label,
  select,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  emptyState,
  formatCurrency,
  formatIstDateTime,
  render,
  statCard,
  errorLine,
} from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { notify, notifyError } from '../core/toast.js';

const data = pageData();
const CHECK_EVERY_MS = 30_000;
const state = {
  open: [],
  closed: [],
  summary: null,
  loading: true,
  error: '',
  starting: false,
  formError: '',
  checkedAt: null,
};

const REASONS = { stop: 'Stop hit', target: 'Target hit', manual: 'Closed by you' };

/* ------------------------------------- form ------------------------------------- */

const fields = {
  symbol: input({ id: 'paper-symbol', placeholder: 'RELIANCE', autocomplete: 'off' }),
  direction: select({ id: 'paper-direction' }, [
    { value: 'Long', label: 'Long', selected: true },
    { value: 'Short', label: 'Short' },
  ]),
  quantity: input({ id: 'paper-qty', type: 'number', min: '1', step: '1', placeholder: '10' }),
  stopLoss: input({
    id: 'paper-stop',
    type: 'number',
    min: '0',
    step: 'any',
    placeholder: t('Optional'),
  }),
  takeProfit: input({
    id: 'paper-target',
    type: 'number',
    min: '0',
    step: 'any',
    placeholder: t('Optional'),
  }),
};
const symbols = h(
  'datalist',
  { id: 'paper-watchlist' },
  (data.workspace?.watchlist ?? []).map((item) => h('option', { value: item.symbol })),
);
fields.symbol.setAttribute('list', 'paper-watchlist');
const formError = h('div');
const startButton = button(t('Start paper trade'), { type: 'submit', className: 'w-full' });
const form = h(
  'form',
  { class: 'space-y-4', novalidate: true },
  h('div', { class: 'space-y-2' }, label(t('Symbol'), fields.symbol.id), fields.symbol, symbols),
  h(
    'div',
    { class: 'grid grid-cols-2 gap-4' },
    h('div', { class: 'space-y-2' }, label(t('Direction'), fields.direction.id), fields.direction),
    h('div', { class: 'space-y-2' }, label(t('Quantity'), fields.quantity.id), fields.quantity),
    h('div', { class: 'space-y-2' }, label(t('Stop loss'), fields.stopLoss.id), fields.stopLoss),
    h('div', { class: 'space-y-2' }, label(t('Target'), fields.takeProfit.id), fields.takeProfit),
  ),
  formError,
  startButton,
  h(
    'p',
    { class: 'text-xs leading-5 text-muted' },
    'Entry is the current price. Charges use your equity rates. To start from a saved plan, use “Paper trade” on the Orders page.',
  ),
);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.starting) return;
  state.starting = true;
  state.formError = '';
  paintForm();
  try {
    const { trade } = await api('/api/paper', {
      method: 'POST',
      body: {
        symbol: fields.symbol.value,
        direction: fields.direction.value,
        quantity: fields.quantity.value,
        stopLoss: fields.stopLoss.value || null,
        takeProfit: fields.takeProfit.value || null,
      },
    });
    notify(`Paper trade started: ${trade.symbol} at ₹${trade.entryPrice}.`, 'success');
    form.reset();
    await load();
  } catch (error) {
    state.formError = errorMessage(error, 'Could not start the paper trade.');
  } finally {
    state.starting = false;
    paintForm();
  }
});

function paintForm() {
  startButton.disabled = state.starting;
  startButton.textContent = state.starting ? 'Reading the price…' : 'Start paper trade';
  render(formError, errorLine(state.formError));
}

render(
  $('[data-paper-form]'),
  card({}, cardHeader('', cardTitle(t('New paper trade'))), cardContent('', form)),
);

/* ------------------------------------ trades ------------------------------------ */

async function act(path, method, success, failure) {
  try {
    await api(path, { method });
    notify(success, 'success');
    await load();
  } catch (error) {
    notifyError(error, failure);
  }
}

function openRow(trade) {
  return h(
    'tr',
    { class: 'border-b border-line last:border-0' },
    h(
      'td',
      { class: 'py-2 pr-3' },
      h('span', { class: 'font-medium text-fg' }, trade.symbol),
      h('span', { class: 'ml-2 text-xs text-muted' }, `${trade.direction} · ${trade.quantity}`),
    ),
    h('td', { class: 'py-2 pr-3 text-right' }, `₹${trade.entryPrice}`),
    h(
      'td',
      { class: 'py-2 pr-3 text-right' },
      trade.lastPrice === null ? '—' : `₹${trade.lastPrice}`,
    ),
    h(
      'td',
      { class: 'py-2 pr-3 text-right text-xs text-muted' },
      `${trade.stopLoss ?? '—'} / ${trade.takeProfit ?? '—'}`,
    ),
    h(
      'td',
      { class: cn('py-2 pr-3 text-right font-medium', tone(trade.openPnl)) },
      signed(trade.openPnl),
    ),
    h(
      'td',
      { class: 'py-2 text-right' },
      button(t('Close'), {
        variant: 'outline',
        size: 'sm',
        'aria-label': `Close the ${trade.symbol} paper trade`,
        onclick: () =>
          void act(
            `/api/paper/${encodeURIComponent(trade.id)}/close`,
            'POST',
            `${trade.symbol} paper trade closed.`,
            'Could not close the paper trade.',
          ),
      }),
    ),
  );
}

function closedRow(trade) {
  return h(
    'tr',
    { class: 'border-b border-line last:border-0' },
    h(
      'td',
      { class: 'py-2 pr-3' },
      h('span', { class: 'font-medium text-fg' }, trade.symbol),
      h('span', { class: 'ml-2 text-xs text-muted' }, `${trade.direction} · ${trade.quantity}`),
      h('div', { class: 'text-xs text-muted' }, formatIstDateTime(trade.closedAt)),
    ),
    h('td', { class: 'py-2 pr-3 text-right' }, `₹${trade.entryPrice} → ₹${trade.exitPrice}`),
    h('td', { class: 'py-2 pr-3 text-right text-xs text-muted' }, REASONS[trade.exitReason] ?? ''),
    h('td', { class: 'py-2 pr-3 text-right' }, formatCurrency(trade.charges)),
    h('td', { class: cn('py-2 pr-3 text-right font-medium', tone(trade.pnl)) }, signed(trade.pnl)),
    h(
      'td',
      { class: 'py-2 text-right' },
      button(t('Delete'), {
        variant: 'ghost',
        size: 'sm',
        className: 'text-negative',
        'aria-label': `Delete the ${trade.symbol} paper trade`,
        onclick: () =>
          void act(
            `/api/paper/${encodeURIComponent(trade.id)}`,
            'DELETE',
            'Paper trade deleted.',
            'Could not delete the paper trade.',
          ),
      }),
    ),
  );
}

function tableOf(head, rows) {
  return h(
    'div',
    { class: 'overflow-x-auto' },
    h(
      'table',
      { class: 'stack-table w-full min-w-[560px] tnum text-sm' },
      h(
        'thead',
        { class: 'border-b border-line text-left text-xs uppercase tracking-wide text-muted' },
        h(
          'tr',
          {},
          head.map((cell, index) =>
            h('th', { class: cn('py-2 pr-3', index > 0 && 'text-right') }, cell),
          ),
        ),
      ),
      h('tbody', {}, rows),
    ),
  );
}

function paint() {
  const summary = state.summary;
  render(
    $('[data-paper-trades]'),
    state.error ? errorLine(state.error) : null,
    summary && summary.totalTrades
      ? h(
          'div',
          { class: 'grid gap-3 sm:grid-cols-3' },
          statCard({
            label: `Closed (${summary.totalTrades})`,
            value: signed(summary.netPnl),
            tone: summary.netPnl >= 0 ? 'positive' : 'negative',
          }),
          statCard({ label: 'Win rate', value: `${summary.winRate.toFixed(1)}%` }),
          statCard({
            label: 'Profit factor',
            value: summary.profitFactor === null ? '—' : String(summary.profitFactor),
          }),
        )
      : null,
    card(
      {},
      cardHeader(
        '',
        h(
          'div',
          {},
          cardTitle(`Open (${state.open.length})`),
          h(
            'p',
            { class: 'mt-1 text-xs text-muted' },
            state.checkedAt
              ? `Prices checked ${formatIstDateTime(state.checkedAt)} IST; re-checked every 30 seconds while this page is open.`
              : 'Loading…',
          ),
        ),
      ),
      cardContent(
        '',
        state.open.length
          ? tableOf(
              ['Trade', 'Entry', 'Last', 'Stop / target', 'Open P&L', ''],
              state.open.map(openRow),
            )
          : h(
              'p',
              { class: 'text-sm text-muted' },
              state.loading ? 'Loading…' : 'No open paper trades.',
            ),
      ),
    ),
    card(
      {},
      cardHeader('', cardTitle(t('Closed'))),
      cardContent(
        '',
        state.closed.length
          ? tableOf(
              ['Trade', 'Entry → exit', 'Reason', 'Charges', 'Net P&L', ''],
              state.closed.map(closedRow),
            )
          : emptyState({
              iconName: 'beaker',
              title: t('No closed paper trades yet'),
              hint: t('Results appear here when a stop, a target or you close a trade.'),
            }),
      ),
    ),
  );
}

let checking = false;
/** Checks open trades against the live price (closing any that hit their stop or target). */
async function load() {
  if (checking) return;
  checking = true;
  try {
    const result = await api('/api/paper/refresh', { method: 'POST', timeout: 60_000 });
    Object.assign(state, {
      open: result.open,
      closed: result.closed,
      summary: result.summary,
      error: '',
      checkedAt: new Date().toISOString(),
    });
    if (result.closedNow) {
      notify(
        `${result.closedNow} paper ${result.closedNow === 1 ? 'trade' : 'trades'} reached a stop or target.`,
        'success',
      );
    }
  } catch (error) {
    state.error = errorMessage(error, 'Paper trades could not be loaded.');
  } finally {
    state.loading = false;
    checking = false;
    paint();
  }
}

paintForm();
paint();
void load();
setInterval(() => {
  if (!document.hidden && state.open.length) void load();
}, CHECK_EVERY_MS);
