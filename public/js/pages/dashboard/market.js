/**
 * Market workspace: instrument picker, latest quote, broker status and the
 * price history chart.
 */
import { $, h, icon, buttonClass, render } from '../../core/dom.js';
import { fetchBrokerStatus, fetchQuote } from '../../lib/quotes.js';
import { createMarketHistoryChart } from '../../components/market-history-chart.js';
import { data, watchlist } from './shared.js';

function priceText(quote) {
  const price = quote.price;
  if (price === null || !Number.isFinite(price) || price <= 0) return 'Price unavailable';
  if (!quote.currency || !/^[A-Z]{3}$/.test(quote.currency)) {
    return `${price.toLocaleString('en-IN', { maximumFractionDigits: 2 })} · currency unverified`;
  }
  return price.toLocaleString('en-IN', { style: 'currency', currency: quote.currency });
}

const marketState = { symbol: watchlist[0]?.symbol ?? '', quote: null, status: 'idle', token: 0 };
const chart = createMarketHistoryChart({ accountId: data.accountId, symbol: marketState.symbol });

/**
 * Renders the watchlist instruments column; the selected row shows its price and day
 * change, and clicking a row selects that symbol.
 */
export function paintInstruments() {
  const container = $('[data-instruments]');
  if (!watchlist.length) return;
  const valid = marketState.status === 'ready' ? marketState.quote : null;
  const change =
    valid?.price != null &&
    valid.price > 0 &&
    Number.isFinite(valid.price) &&
    valid.previousClose != null &&
    valid.previousClose > 0 &&
    Number.isFinite(valid.previousClose)
      ? ((valid.price - valid.previousClose) / valid.previousClose) * 100
      : null;
  render(
    container,
    ...watchlist.map((item) =>
      h(
        'button',
        {
          type: 'button',
          'aria-label': item.symbol,
          'aria-pressed': String(marketState.symbol === item.symbol),
          class: 'focus-ring reference-instrument-row',
          onclick: () => selectSymbol(item.symbol),
        },
        h('span', {}, h('strong', {}, item.symbol), h('small', {}, 'NSE · Saved instrument')),
        h(
          'span',
          { class: 'reference-instrument-price' },
          h(
            'strong',
            {},
            item.symbol === marketState.symbol &&
              valid?.price != null &&
              Number.isFinite(valid.price) &&
              valid.price > 0
              ? valid.price.toLocaleString('en-IN', {
                  maximumFractionDigits: 2,
                  minimumFractionDigits: 2,
                })
              : '—',
          ),
          h(
            'small',
            {},
            item.symbol === marketState.symbol && change !== null && Number.isFinite(change)
              ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`
              : 'Unverified',
          ),
        ),
      ),
    ),
  );
}

/** Renders the selected instrument's heading, quote snapshot and source, refresh button and chart. */
export function paintChartSurface() {
  const { symbol, status, quote } = marketState;
  const loading = Boolean(symbol) && status === 'loading';
  const valid = status === 'ready' && quote?.symbol === symbol ? quote : null;
  const source =
    valid?.source === 'kite'
      ? 'Zerodha Kite'
      : valid?.source === 'yahoo'
        ? 'Yahoo Finance'
        : 'Unverified provider';
  const surface = $('[data-chart-surface]');
  const refresh = symbol
    ? h(
        'button',
        {
          type: 'button',
          class: buttonClass('outline', 'sm'),
          disabled: loading,
          'aria-label': `Refresh ${symbol} quote`,
          onclick: () => loadQuote(),
        },
        icon('refresh-cw', 13, loading ? 'animate-spin' : ''),
      )
    : null;
  render(
    surface,
    h(
      'div',
      { class: 'reference-chart-heading' },
      h(
        'div',
        {},
        h(
          'div',
          { class: 'reference-instrument-title' },
          h(
            'span',
            { class: 'reference-instrument-monogram', 'aria-hidden': 'true' },
            symbol.charAt(0) || '—',
          ),
          h(
            'div',
            {},
            h('h3', {}, `${symbol || 'Start with an idea'} `, h('span', {}, symbol ? 'NSE' : '')),
            h(
              'small',
              {},
              symbol ? 'Selected instrument · Quote snapshot' : 'Save an instrument to begin',
            ),
          ),
        ),
        symbol
          ? h(
              'div',
              { 'aria-live': 'polite', 'aria-atomic': 'true' },
              h(
                'p',
                { class: 'reference-chart-price' },
                loading ? 'Loading quote…' : valid ? priceText(valid) : 'Price unavailable',
              ),
              h(
                'p',
                { class: 'reference-quote-provenance' },
                valid
                  ? `${source} snapshot · Provider timestamp unavailable`
                  : loading
                    ? 'Checking the available data source.'
                    : 'The data source could not be verified. You can retry the quote.',
              ),
            )
          : null,
      ),
      h('div', { class: 'reference-chart-tools' }, h('span', {}, 'Candlesticks'), refresh),
    ),
    chart.element,
    h(
      'div',
      { class: 'reference-chart-foot' },
      h('span', {}, 'Research snapshot · Order submission disabled'),
      h(
        'a',
        {
          href: symbol ? `/calculator?symbol=${encodeURIComponent(symbol)}` : '/calculator',
          class: 'focus-ring reference-text-link',
        },
        'Plan the risk ',
        icon('arrow-right', 13),
      ),
    ),
  );
}

/** Fetches a quote for the selected symbol (15s timeout) and repaints; stale responses are dropped. */
export async function loadQuote() {
  const { symbol } = marketState;
  if (!symbol) return;
  const token = ++marketState.token;
  marketState.status = 'loading';
  marketState.quote = null;
  paintInstruments();
  paintChartSurface();
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 15_000),
  );
  try {
    const quote = await Promise.race([fetchQuote(symbol), timeout]);
    if (token !== marketState.token) return;
    marketState.quote = quote;
    marketState.status = 'ready';
  } catch {
    if (token !== marketState.token) return;
    marketState.status = 'error';
  }
  paintInstruments();
  paintChartSurface();
}

function selectSymbol(symbol) {
  if (symbol === marketState.symbol) return;
  marketState.symbol = symbol;
  chart.setSymbol(symbol);
  void loadQuote();
}

/** Fills the broker status label from the broker status API, falling back after 15s or on error. */
export async function loadBrokerStatus() {
  const target = $('[data-broker-status]');
  let failed = false;
  const timer = setTimeout(() => {
    failed = true;
    target.textContent = 'Status unavailable';
  }, 15_000);
  try {
    const broker = await fetchBrokerStatus();
    if (failed) return;
    if (!broker || typeof broker.connected !== 'boolean' || typeof broker.configured !== 'boolean')
      throw new Error('Invalid broker status');
    const expiry = broker.expiresAt ? Date.parse(broker.expiresAt) : NaN;
    const linked = broker.connected && Number.isFinite(expiry) && expiry > Date.now();
    target.textContent = linked
      ? 'Read-only session linked'
      : broker.connected
        ? 'Session needs verification'
        : 'Disconnected';
  } catch {
    target.textContent = 'Status unavailable';
  } finally {
    clearTimeout(timer);
  }
}
