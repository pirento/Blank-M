/**
 * The trade ledger. This page is also the only way to correct a mistake: a
 * mistyped trade can be edited (economics are recomputed on the server) or
 * deleted, and the balance is always derived from the remaining rows.
 */
import { t } from '../core/i18n.js';
import {
  $,
  $$,
  h,
  icon,
  cn,
  pageData,
  button,
  buttonClass,
  input,
  label,
  emptyState,
  formatCurrency,
  render,
  downloadText,
} from '../core/dom.js';
import { api } from '../core/api.js';
import { openModal } from '../core/dialog.js';
import { notify, notifyError } from '../core/toast.js';
import { summarisePerformance } from '../../../shared/pnl.js';
import { isBusinessDate } from '../../../shared/business-dates.js';
import { todayInIst } from '../../../shared/market.js';
import { buildTradesCsv } from '../../../shared/trade-export.js';
import {
  EMPTY_FILTERS,
  describeFilters,
  isEmptyFilters,
  loadViews,
  saveViews,
  upsertView,
} from '../lib/views.js';
import { createTradeForm } from '../components/trade-form.js';
import { openTradeScreenshot } from '../components/trade-screenshot.js';
import { openTradeReplay } from '../components/trade-replay.js';
import { createBrokerPortfolio } from '../components/broker-portfolio.js';

const data = pageData();
const ownerId = data.accountId;
const workspace = data.workspace;
const available = Boolean(workspace);
const strategyName = (id) =>
  (workspace?.strategies ?? []).find((strategy) => strategy.id === id)?.name ?? null;

/** Ledger rows drawn at once; large journals stay fast to filter and scroll. */
const LEDGER_PAGE_SIZE = 200;

const state = {
  trades: workspace?.trades ?? [],
  filters: { ...EMPTY_FILTERS },
  views: loadViews(ownerId),
  sortKey: 'date',
  sortDirection: 'desc',
  selected: new Set(),
  busy: false,
  // How many matching rows the ledger shows; "Show more" raises it.
  shown: LEDGER_PAGE_SIZE,
};

/** Matching rows currently drawn in the ledger (totals and export use all of them). */
const shownRows = (rows) => rows.slice(0, state.shown);

function rangeError() {
  const { from, to } = state.filters;
  if ((from && !isBusinessDate(from)) || (to && !isBusinessDate(to)))
    return 'Choose valid start and end dates.';
  if (from && to && from > to) return 'The start date must be on or before the end date.';
  return '';
}

function filtered() {
  if (!available || rangeError()) return [];
  const { search, direction, outcome, from, to, segment, strategy } = state.filters;
  const term = search.trim().toUpperCase();
  const rows = state.trades.filter((trade) => {
    if (
      term &&
      !trade.symbol.includes(term) &&
      !trade.notes.toUpperCase().includes(term) &&
      ![...(trade.setupTags ?? []), ...(trade.mistakeTags ?? [])].some((tag) =>
        tag.toUpperCase().includes(term),
      )
    )
      return false;
    if (direction !== 'all' && trade.type !== direction) return false;
    if (outcome === 'wins' && trade.pnl <= 0) return false;
    if (outcome === 'losses' && trade.pnl >= 0) return false;
    if (from && trade.date < from) return false;
    if (to && trade.date > to) return false;
    if (segment !== 'all' && (trade.segment ?? 'EQ') !== segment) return false;
    if (strategy === 'none' && trade.strategyId) return false;
    if (strategy !== 'all' && strategy !== 'none' && trade.strategyId !== strategy) return false;
    return true;
  });
  const factor = state.sortDirection === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    switch (state.sortKey) {
      case 'symbol':
        return a.symbol.localeCompare(b.symbol) * factor;
      case 'pnl':
        return (a.pnl - b.pnl) * factor;
      case 'quantity':
        return (a.quantity - b.quantity) * factor;
      default:
        return (a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)) * factor;
    }
  });
}

function syncFilterInputs() {
  for (const element of $$('[data-filter]')) element.value = state.filters[element.dataset.filter];
}

function persistViews(next) {
  state.views = next;
  const persisted = saveViews(ownerId, next);
  if (!persisted)
    notify('View changes apply only to this session. Browser storage is unavailable.', 'error');
  return persisted;
}

function openSaveView() {
  openModal({
    title: t('Save this view'),
    content: (close) => {
      const name = input({ id: 'view-name', placeholder: t('e.g. Losing shorts') });
      const submit = button(t('Save view'), {
        type: 'submit',
        className: 'flex-1',
        disabled: true,
      });
      name.addEventListener('input', () => {
        submit.disabled = !name.value.trim();
      });
      const form = h(
        'form',
        { class: 'space-y-4' },
        h('div', { class: 'space-y-2' }, label(t('Name'), 'view-name'), name),
        h(
          'div',
          { class: 'flex gap-4' },
          button(t('Cancel'), { variant: 'outline', className: 'flex-1', onclick: close }),
          submit,
        ),
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const trimmed = name.value.trim();
        if (!trimmed) return;
        const persisted = persistViews(upsertView(state.views, trimmed, { ...state.filters }));
        close();
        // Toasts can outlive this account boundary, so omit private view names.
        if (persisted) notify('Saved this view.', 'success');
        paint();
      });
      return h(
        'div',
        {},
        h('p', { class: 'mb-4 text-sm text-muted' }, describeFilters(state.filters, strategyName)),
        form,
      );
    },
  });
}

function sortableHeader(text, key, align = 'left') {
  const active = state.sortKey === key;
  return h(
    'th',
    {
      class: `px-4 py-3 ${align === 'right' ? 'text-right' : 'text-left'}`,
      'aria-sort': active ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none',
    },
    h(
      'button',
      {
        type: 'button',
        class: 'focus-ring tracking-wide uppercase transition-opacity hover:opacity-100',
        onclick: () => {
          if (active) state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
          else {
            state.sortKey = key;
            state.sortDirection = 'desc';
          }
          paint();
        },
      },
      text,
      active ? (state.sortDirection === 'asc' ? ' ↑' : ' ↓') : '',
    ),
  );
}

function openEdit(trade) {
  openModal({
    title: t('Edit trade'),
    content: (close) =>
      h(
        'div',
        { class: 'max-h-[70vh] overflow-y-auto pr-1' },
        createTradeForm({
          trade,
          strategies: workspace.strategies,
          settings: workspace.settings,
          onCancel: close,
          onSubmitted: (saved) => {
            close();
            state.trades = state.trades.map((entry) => (entry.id === saved.id ? saved : entry));
            notify('Trade updated.', 'success');
            paint();
          },
        }),
      ),
  });
}

/** Setup tags, mistakes and emotion under the symbol (nothing when none were recorded). */
function tagLine(trade) {
  const contract =
    trade.segment === 'FUT' || trade.segment === 'OPT'
      ? [
          trade.segment === 'FUT'
            ? 'FUT'
            : `${trade.optionType ?? 'OPT'} ${trade.strike ?? ''}`.trim(),
          trade.expiry && `exp ${trade.expiry}`,
          trade.lotSize && `${trade.quantity / trade.lotSize} × ${trade.lotSize}`,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;
  const timing =
    trade.entryTime || trade.exitTime ? `${trade.entryTime ?? '?'}–${trade.exitTime ?? '?'}` : null;
  const parts = [
    contract ? h('span', { class: 'text-fg' }, contract) : null,
    timing ? h('span', { class: 'text-muted' }, timing) : null,
    trade.stopLoss ? h('span', { class: 'text-muted' }, `SL ${trade.stopLoss}`) : null,
    trade.exitLegs?.length
      ? h('span', { class: 'text-muted' }, `${trade.exitLegs.length} exits`)
      : null,
    ...(trade.setupTags ?? []).map((tag) => h('span', { class: 'text-accent' }, tag)),
    ...(trade.mistakeTags ?? []).map((tag) => h('span', { class: 'text-negative' }, tag)),
    trade.emotion ? h('span', { class: 'text-muted' }, trade.emotion) : null,
  ].filter(Boolean);
  return parts.length
    ? h('div', { class: 'mt-1 flex max-w-56 flex-wrap gap-x-2 text-[11px] font-normal' }, parts)
    : null;
}

/** Screenshot dialog; a change replaces the trade in the ledger. */
function openScreenshot(trade) {
  openTradeScreenshot(trade, {
    onChange: (saved) => {
      state.trades = state.trades.map((entry) => (entry.id === saved.id ? saved : entry));
      paint();
    },
  });
}

function confirmModal({ title, text, confirmLabel, run }) {
  openModal({
    title,
    content: (close) => {
      const cancel = button(t('Cancel'), {
        variant: 'outline',
        className: 'flex-1',
        onclick: () => !state.busy && close(),
      });
      const confirm = button(confirmLabel, { variant: 'destructive', className: 'flex-1' });
      confirm.addEventListener('click', async () => {
        if (state.busy) return;
        state.busy = true;
        cancel.disabled = true;
        confirm.disabled = true;
        confirm.textContent = 'Deleting…';
        try {
          await run();
        } finally {
          state.busy = false;
          close();
          paint();
        }
      });
      return h(
        'div',
        {},
        h('p', { class: 'mb-6 text-sm text-muted' }, text),
        h('div', { class: 'flex gap-4' }, cancel, confirm),
      );
    },
  });
}

function deleteOne(trade) {
  confirmModal({
    title: t('Delete trade'),
    text: `Permanently delete the ${trade.symbol} trade from ${trade.date}? Your balance will be recalculated without it.`,
    confirmLabel: 'Delete',
    run: async () => {
      try {
        await api(`/api/trades/${encodeURIComponent(trade.id)}`, { method: 'DELETE' });
        state.trades = state.trades.filter((entry) => entry.id !== trade.id);
        state.selected.delete(trade.id);
        notify(`Deleted ${trade.symbol} trade.`, 'success');
      } catch (error) {
        notifyError(error, 'Could not delete the trade.');
      }
    },
  });
}

/**
 * Deletes sequentially and reports what actually happened. A partial failure
 * would otherwise leave the balance wrong with no indication of which rows
 * survived.
 */
function deleteSelected() {
  const count = state.selected.size;
  confirmModal({
    title: t('Delete trades'),
    text: `Permanently delete ${count} ${count === 1 ? 'trade' : 'trades'}? Your balance will be recalculated without them. This cannot be undone.`,
    confirmLabel: `Delete ${count}`,
    run: async () => {
      const visible = new Set(shownRows(filtered()).map((trade) => trade.id));
      const ids = [...state.selected].filter((id) => visible.has(id));
      const failed = [];
      for (const id of ids) {
        try {
          await api(`/api/trades/${encodeURIComponent(id)}`, { method: 'DELETE' });
          state.trades = state.trades.filter((entry) => entry.id !== id);
        } catch {
          failed.push(id);
        }
      }
      state.selected = new Set(failed);
      const removed = ids.length - failed.length;
      if (failed.length === 0)
        notify(`Deleted ${removed} ${removed === 1 ? 'trade' : 'trades'}.`, 'success');
      else
        notify(
          `Deleted ${removed} of ${ids.length}. ${failed.length} could not be removed.`,
          'error',
        );
    },
  });
}

function ledgerTable(rows) {
  const allSelected = rows.length > 0 && state.selected.size === rows.length;
  const checkboxClass =
    'focus-ring h-4 w-4 rounded border-line-strong accent-[var(--color-accent)]';
  return h(
    'div',
    { class: 'overflow-x-auto' },
    h(
      'table',
      { class: 'stack-table w-full min-w-[880px] tnum text-xs' },
      h(
        'thead',
        { class: 'border-b border-line text-left text-xs tracking-wide uppercase text-muted' },
        h(
          'tr',
          {},
          h(
            'th',
            { class: 'w-10 px-4 py-3' },
            h('input', {
              type: 'checkbox',
              checked: allSelected,
              'aria-label': t('Select every visible trade'),
              class: checkboxClass,
              onchange: () => {
                state.selected = allSelected ? new Set() : new Set(rows.map((trade) => trade.id));
                paint();
              },
            }),
          ),
          sortableHeader('Date', 'date'),
          sortableHeader('Symbol', 'symbol'),
          h('th', { class: 'px-4 py-3' }, 'Dir'),
          sortableHeader('Qty', 'quantity', 'right'),
          h('th', { class: 'px-4 py-3 text-right' }, 'Entry'),
          h('th', { class: 'px-4 py-3 text-right' }, 'Exit'),
          h('th', { class: 'px-4 py-3 text-right' }, 'Charges'),
          sortableHeader('Net P&L', 'pnl', 'right'),
          h('th', { class: 'px-4 py-3 text-right' }, 'Actions'),
        ),
      ),
      h(
        'tbody',
        {},
        rows.map((trade) =>
          h(
            'tr',
            {
              class: cn(
                'border-b border-line transition-colors last:border-0 hover:bg-elevated',
                state.selected.has(trade.id) && 'bg-accent-soft',
              ),
            },
            h(
              'td',
              { class: 'px-4 py-3' },
              h('input', {
                type: 'checkbox',
                checked: state.selected.has(trade.id),
                'aria-label': `Select the ${trade.symbol} trade from ${trade.date}`,
                class: checkboxClass,
                onchange: () => {
                  if (state.selected.has(trade.id)) state.selected.delete(trade.id);
                  else state.selected.add(trade.id);
                  paint();
                },
              }),
            ),
            h('td', { class: 'px-4 py-3 whitespace-nowrap' }, trade.date),
            h(
              'td',
              { class: 'px-4 py-3' },
              h('span', { class: 'font-bold text-fg' }, trade.symbol),
              tagLine(trade),
            ),
            h(
              'td',
              { class: 'px-4 py-3' },
              h(
                'span',
                { class: trade.type === 'Long' ? 'text-positive' : 'text-negative' },
                trade.type,
              ),
            ),
            h('td', { class: 'px-4 py-3 text-right' }, String(trade.quantity)),
            h('td', { class: 'px-4 py-3 text-right' }, String(trade.entryPrice)),
            h('td', { class: 'px-4 py-3 text-right' }, String(trade.exitPrice)),
            h('td', { class: 'px-4 py-3 text-right text-muted' }, formatCurrency(trade.charges)),
            h(
              'td',
              {
                class: `px-4 py-3 text-right font-bold ${trade.pnl >= 0 ? 'text-positive' : 'text-negative'}`,
              },
              `${trade.pnl >= 0 ? '+' : '-'}${formatCurrency(Math.abs(trade.pnl))}`,
            ),
            h(
              'td',
              { class: 'px-4 py-3' },
              h(
                'div',
                { class: 'flex justify-end gap-1' },
                button(icon('candlestick-chart', 14), {
                  variant: 'ghost',
                  size: 'sm',
                  'aria-label': `Replay ${trade.symbol} trade on the chart`,
                  onclick: () => openTradeReplay(trade, { accountId: ownerId }),
                }),
                button(icon('image', 14), {
                  variant: 'ghost',
                  size: 'sm',
                  className: trade.hasScreenshot ? 'text-accent' : '',
                  'aria-label': `${trade.hasScreenshot ? 'View' : 'Add'} ${trade.symbol} chart screenshot`,
                  onclick: () => openScreenshot(trade),
                }),
                button(icon('pencil', 14), {
                  variant: 'ghost',
                  size: 'sm',
                  'aria-label': `Edit ${trade.symbol} trade`,
                  onclick: () => openEdit(trade),
                }),
                button(icon('trash-2', 14), {
                  variant: 'ghost',
                  size: 'sm',
                  className: 'text-negative hover:bg-negative-soft',
                  'aria-label': `Delete ${trade.symbol} trade`,
                  onclick: () => deleteOne(trade),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function paint() {
  const rows = filtered();
  const problem = rangeError();
  // A selection must never outlive the rows it points at, or a bulk delete
  // could remove a trade the user can no longer see.
  const visible = new Set(shownRows(rows).map((trade) => trade.id));
  state.selected = new Set([...state.selected].filter((id) => visible.has(id)));

  const summary = summarisePerformance(rows);
  $('[data-summary]').textContent =
    `${rows.length} of ${state.trades.length} trades · net ${formatCurrency(summary.netPnl)} after ${formatCurrency(summary.charges)} in charges`;
  $('[data-export]').disabled = rows.length === 0;

  render(
    $('[data-filter-actions]'),
    isEmptyFilters(state.filters)
      ? null
      : [
          button(t('Clear'), {
            variant: 'ghost',
            size: 'sm',
            onclick: () => {
              state.filters = { ...EMPTY_FILTERS };
              syncFilterInputs();
              paint();
            },
          }),
          button([icon('bookmark-plus', 14, 'mr-1.5'), 'Save view'], {
            variant: 'outline',
            size: 'sm',
            onclick: openSaveView,
          }),
        ],
  );

  const viewsBox = $('[data-views]');
  viewsBox.hidden = state.views.length === 0;
  render(
    viewsBox,
    state.views.map((view) =>
      h(
        'span',
        {
          class:
            'flex items-center gap-1 rounded-full border border-line bg-elevated pr-1 pl-3 text-xs',
        },
        h(
          'button',
          {
            type: 'button',
            title: describeFilters(view.filters, strategyName),
            class: 'focus-ring rounded-full py-1.5 font-medium text-fg',
            onclick: () => {
              state.filters = { ...view.filters };
              // A view saved with a since-deleted strategy would silently show nothing.
              const { strategy } = state.filters;
              if (
                strategy !== 'all' &&
                strategy !== 'none' &&
                !workspace.strategies.some((item) => item.id === strategy)
              )
                state.filters.strategy = 'all';
              state.selected = new Set();
              syncFilterInputs();
              paint();
            },
          },
          view.name,
        ),
        h(
          'button',
          {
            type: 'button',
            'aria-label': `Delete the ${view.name} view`,
            class: 'focus-ring rounded-full p-1 text-subtle hover:text-negative',
            onclick: () => {
              persistViews(state.views.filter((entry) => entry.id !== view.id));
              paint();
            },
          },
          icon('x', 12),
        ),
      ),
    ),
  );

  const status = $('[data-range-error]');
  status.hidden = !(problem || !available);
  status.setAttribute('role', 'alert');
  status.textContent = problem || (available ? '' : 'Journal records could not be loaded.');

  render(
    $('[data-selection]'),
    state.selected.size > 0
      ? h(
          'div',
          {
            class:
              'sticky top-16 z-20 flex flex-wrap items-center justify-between gap-3 rounded-card border border-accent bg-accent-soft px-4 py-3',
          },
          h(
            'span',
            { class: 'text-sm font-medium text-fg' },
            `${state.selected.size} ${state.selected.size === 1 ? 'trade' : 'trades'} selected`,
          ),
          h(
            'div',
            { class: 'flex gap-2' },
            button(t('Clear selection'), {
              variant: 'ghost',
              size: 'sm',
              onclick: () => {
                state.selected = new Set();
                paint();
              },
            }),
            button([icon('trash-2', 14, 'mr-1.5'), 'Delete selected'], {
              variant: 'destructive',
              size: 'sm',
              onclick: deleteSelected,
            }),
          ),
        )
      : null,
  );

  render(
    $('[data-ledger]'),
    problem || !available
      ? h(
          'p',
          { class: 'p-6 text-sm text-muted' },
          'Journal records are unavailable for this view. This is not a verified empty trade history.',
        )
      : rows.length === 0
        ? h(
            'div',
            { class: 'p-6' },
            emptyState({
              iconName: 'arrow-right-left',
              title: state.trades.length === 0 ? 'No trades yet' : 'No trades match these filters',
              hint:
                state.trades.length === 0
                  ? 'Log one in the Journal, or import a broker CSV.'
                  : 'Try widening the range.',
              action:
                state.trades.length === 0
                  ? h('a', { href: '/import', class: buttonClass('outline') }, 'Import a CSV')
                  : null,
            }),
          )
        : [
            ledgerTable(shownRows(rows)),
            rows.length > state.shown
              ? h(
                  'div',
                  {
                    class:
                      'flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-xs text-muted',
                  },
                  `Showing ${state.shown} of ${rows.length} matching trades.`,
                  button(`Show ${Math.min(LEDGER_PAGE_SIZE, rows.length - state.shown)} more`, {
                    variant: 'outline',
                    size: 'sm',
                    onclick: () => {
                      state.shown += LEDGER_PAGE_SIZE;
                      paint();
                    },
                  }),
                )
              : null,
          ],
  );
}

// Typing in search waits a moment before re-filtering a large ledger; the
// other filters apply at once.
let searchTimer;
for (const element of $$('[data-filter]')) {
  element.addEventListener('input', () => {
    state.filters = { ...state.filters, [element.dataset.filter]: element.value };
    clearTimeout(searchTimer);
    if (element.dataset.filter === 'search') searchTimer = setTimeout(paint, 150);
    else paint();
  });
}

$('[data-export]').addEventListener('click', () => {
  const rows = filtered();
  if (rangeError() || rows.length === 0) return;
  downloadText(`trades-${todayInIst()}.csv`, buildTradesCsv(rows), 'text/csv;charset=utf-8;');
});

render(
  $('[data-broker-portfolio]'),
  createBrokerPortfolio({
    available: Boolean(ownerId),
    onFillsJournaled: (added) => {
      state.trades = [...added, ...state.trades];
      paint();
    },
  }),
);
paint();
