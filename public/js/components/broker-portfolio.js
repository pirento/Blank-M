/**
 * Zerodha portfolio panel: holdings, positions, orders and fills (read-only).
 */
import {
  h,
  icon,
  button,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  select,
  render,
  formatIstDateTime,
} from '../core/dom.js';
import { brokerPortfolioSchema } from '../../../shared/broker-portfolio.js';
import { formatPlanningPrice } from '../../../shared/risk-calculator.js';
import { fetchBrokerPortfolio } from '../lib/quotes.js';
import { openFillsToJournal } from './fills-to-journal.js';

const PAGE_SIZE = 25;
const price = (value) => (value === 0 ? '₹0.00' : formatPlanningPrice(String(value)));
const titles = {
  holdings: 'Holdings',
  net: 'Net positions',
  day: 'Day positions',
  orders: 'Orders today',
  trades: 'Fills today',
};
const quantity = (value) => (value === null ? 'Not supplied' : value.toLocaleString('en-IN'));
const time = (value) => (value ? `${formatIstDateTime(value)} IST` : 'Not supplied');

function sectionSize(snapshot, section) {
  return section === 'net' || section === 'day'
    ? snapshot.positions[section].length
    : snapshot[section].length;
}

function rowsFor(snapshot, section, page) {
  const start = page * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  if (section === 'holdings')
    return snapshot.holdings.slice(start, end).map((row) => ({
      title: `${row.symbol} · ${row.exchange}`,
      fields: [
        ['Quantity', quantity(row.quantity)],
        ['T1 quantity', quantity(row.t1Quantity)],
        ['Used quantity', quantity(row.usedQuantity)],
        ['Average price', price(row.averagePrice)],
        ['Last price at snapshot', price(row.lastPrice)],
        ['ISIN', row.isin ?? 'Not supplied'],
      ],
    }));
  if (section === 'net' || section === 'day')
    return snapshot.positions[section].slice(start, end).map((row) => ({
      title: `${row.symbol} · ${row.exchange} · ${row.product}`,
      fields: [
        ['Net quantity', quantity(row.quantity)],
        ['Average price', price(row.averagePrice)],
        ['Last price at snapshot', price(row.lastPrice)],
      ],
    }));
  if (section === 'orders')
    return snapshot.orders.slice(start, end).map((row) => ({
      title: `${row.symbol} · ${row.side} · ${row.status}`,
      fields: [
        ['Order ID', row.orderId],
        ['Exchange / product', `${row.exchange} / ${row.product}`],
        ['Order type', row.orderType],
        ['Quantity', quantity(row.quantity)],
        ['Filled quantity', quantity(row.filledQuantity)],
        ['Pending quantity', quantity(row.pendingQuantity)],
        ['Cancelled quantity', quantity(row.cancelledQuantity)],
        ['Order price', price(row.price)],
        ['Average fill price', price(row.averagePrice)],
        ['Placed', time(row.placedAt)],
      ],
    }));
  return snapshot.trades.slice(start, end).map((row) => ({
    title: `${row.symbol} · ${row.side} · ${row.exchange}`,
    fields: [
      ['Trade ID', row.tradeId],
      ['Order ID', row.orderId],
      ['Product', row.product],
      ['Filled quantity', quantity(row.quantity)],
      ['Average fill price', price(row.averagePrice)],
      ['Filled', time(row.filledAt)],
    ],
  }));
}

/**
 * Read-only, explicitly refreshed Zerodha holdings, positions, orders and fills.
 * With `onFillsJournaled`, also offers to add today's fills to the journal.
 */
export function createBrokerPortfolio({ available = true, onFillsJournaled } = {}) {
  const state = { snapshot: null, error: null, busy: false, section: 'holdings', page: 0 };
  const refreshButton = button('', {
    variant: 'outline',
    className: 'max-w-full whitespace-normal text-left',
  });
  const body = h('div', { class: 'space-y-4' });
  const element = card(
    { 'aria-label': 'Broker portfolio', className: 'min-w-0' },
    cardHeader(
      'flex-wrap',
      h(
        'div',
        { class: 'min-w-0' },
        cardTitle('Broker portfolio'),
        h('p', { class: 'mt-1 text-xs text-muted' }, 'Zerodha Kite · read-only snapshot'),
      ),
      h(
        'div',
        { class: 'flex flex-wrap gap-2' },
        refreshButton,
        onFillsJournaled && available
          ? button([icon('book-open', 14, 'mr-2 shrink-0'), 'Add today’s fills to journal'], {
              variant: 'outline',
              onclick: () => openFillsToJournal({ onAdded: onFillsJournaled }),
            })
          : null,
      ),
    ),
    cardContent(
      'space-y-4',
      h(
        'p',
        { class: 'text-sm leading-6 text-muted' },
        'Read holdings, positions, and today’s orders and fills on request. These records stay separate from saved plans and journal entries. This view cannot place orders or establish realised net profit after charges.',
      ),
      h(
        'p',
        { class: 'text-xs leading-5 text-muted' },
        'Prices are captured values. Holdings quantities do not confirm eligibility to sell. The broker sections are read in sequence and can change during a refresh.',
      ),
      h(
        'a',
        { href: '/settings', class: 'focus-ring inline-block text-sm underline' },
        'Manage broker connection',
      ),
      body,
    ),
  );
  let request = null;
  async function refresh() {
    if (!available || request) return;
    const controller = new AbortController();
    request = controller;
    Object.assign(state, { busy: true, snapshot: null, error: null, page: 0 });
    paint();
    try {
      state.snapshot = await fetchBrokerPortfolio(brokerPortfolioSchema, controller.signal);
    } catch (reason) {
      state.error = reason instanceof Error ? reason.message : 'Could not read broker records.';
    } finally {
      request = null;
      state.busy = false;
      paint();
    }
  }
  refreshButton.addEventListener('click', () => void refresh());

  function paint() {
    refreshButton.disabled = !available || state.busy;
    render(
      refreshButton,
      icon('refresh-cw', 14, 'mr-2 shrink-0'),
      state.busy ? 'Refreshing broker records…' : 'Refresh broker records',
    );
    const parts = [
      state.error
        ? h('p', { role: 'alert', class: 'mt-1 text-xs text-negative' }, state.error)
        : null,
    ];
    if (!available) {
      parts.push(
        h(
          'p',
          { role: 'status', class: 'text-sm text-muted' },
          'Verify your current account and workspace access before refreshing broker records.',
        ),
      );
    } else if (!state.snapshot && !state.error) {
      parts.push(
        h(
          'p',
          { role: 'status', class: 'text-sm text-muted' },
          state.busy
            ? 'Reading all broker sections…'
            : 'No snapshot loaded. Refresh to read your linked broker account.',
        ),
      );
    }
    const snapshot = state.snapshot;
    if (snapshot) {
      const count = sectionSize(snapshot, state.section);
      const rows = rowsFor(snapshot, state.section, state.page);
      const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
      const picker = select(
        { id: 'broker-record-section' },
        Object.keys(titles).map((name) => ({
          value: name,
          selected: name === state.section,
          label: `${titles[name]} (${sectionSize(snapshot, name)})`,
        })),
      );
      picker.addEventListener('change', () => {
        state.section = picker.value;
        state.page = 0;
        paint();
      });
      parts.push(
        h(
          'p',
          { role: 'status', class: 'break-words text-xs leading-5 text-muted' },
          `Source: Zerodha Kite · snapshot started ${time(snapshot.startedAt)} · completed ${time(snapshot.fetchedAt)}. Orders and fills cover ${snapshot.tradingDate} (IST) only. Refresh for newer records.`,
        ),
        h(
          'div',
          { class: 'max-w-sm' },
          h(
            'label',
            { for: 'broker-record-section', class: 'mb-1.5 block text-xs font-medium text-muted' },
            'Broker records',
          ),
          picker,
        ),
        h(
          'section',
          { 'aria-label': titles[state.section], class: 'min-w-0 space-y-3' },
          h(
            'h4',
            { class: 'text-base' },
            `${titles[state.section]} · ${count.toLocaleString('en-IN')}`,
          ),
          rows.length === 0
            ? h(
                'p',
                { class: 'text-sm text-muted' },
                'The broker returned no records in this section.',
              )
            : rows.map((row) =>
                h(
                  'article',
                  { class: 'min-w-0 border border-line p-3 sm:p-4' },
                  h('h5', { class: 'break-words text-sm [overflow-wrap:anywhere]' }, row.title),
                  h(
                    'dl',
                    { class: 'mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3' },
                    row.fields.map(([labelText, value]) =>
                      h(
                        'div',
                        { class: 'min-w-0 text-xs leading-5' },
                        h('dt', { class: 'text-muted' }, labelText),
                        h('dd', { class: 'tnum break-words [overflow-wrap:anywhere]' }, value),
                      ),
                    ),
                  ),
                ),
              ),
          pages > 1
            ? h(
                'nav',
                { 'aria-label': 'Broker record pages', class: 'flex flex-wrap items-center gap-3' },
                button('Previous', {
                  variant: 'outline',
                  size: 'sm',
                  disabled: state.page === 0,
                  onclick: () => {
                    state.page -= 1;
                    paint();
                  },
                }),
                h('span', { class: 'text-xs text-muted' }, `Page ${state.page + 1} of ${pages}`),
                button('Next', {
                  variant: 'outline',
                  size: 'sm',
                  disabled: state.page + 1 >= pages,
                  onclick: () => {
                    state.page += 1;
                    paint();
                  },
                }),
              )
            : null,
        ),
      );
    }
    render(body, parts);
  }
  paint();
  return element;
}
