/**
 * Watchlist page: add and remove instruments, refresh each quote and manage
 * price alerts.
 */
import { $, $$, h, icon, pageData, buttonClass, render } from '../core/dom.js';
import { api } from '../core/api.js';
import { notify, notifyError, reloadWith } from '../core/toast.js';
import { fetchQuote } from '../lib/quotes.js';
import { watchLiveQuotes } from '../lib/live-quotes.js';
import { requestSymbol } from '../lib/ai.js';
import { aiGate } from '../components/ai-gate.js';
import { createPriceAlerts } from '../components/price-alerts.js';
import { NSE_SYMBOL_RE } from '../../../shared/ai-schemas.js';

const data = pageData();
const watchlist = data.workspace.watchlist;

function priceText(quote) {
  if (!quote.currency || !/^[A-Z]{3}$/.test(quote.currency)) {
    return `${quote.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })} · currency unverified`;
  }
  return quote.price.toLocaleString('en-IN', { style: 'currency', currency: quote.currency });
}

/** Quote snapshot per saved instrument, refreshable independently. */
function bindRow(row) {
  const symbol = row.dataset.symbol;
  const quoteCell = $('[data-quote]', row);
  const changeCell = $('[data-change]', row);
  const refresh = $('[data-refresh]', row);
  let token = 0;
  // The last verified snapshot: live prices reuse its currency and previous close.
  let snapshot = null;
  const paintChange = (quote) => {
    const change =
      quote && Number.isFinite(quote.previousClose) && quote.previousClose > 0
        ? ((quote.price - quote.previousClose) / quote.previousClose) * 100
        : null;
    render(
      changeCell,
      change !== null && Number.isFinite(change)
        ? h(
            'span',
            { class: change >= 0 ? 'text-positive' : 'text-negative' },
            `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
            h('span', { class: 'sr-only' }, ' from previous close'),
          )
        : h(
            'span',
            { class: 'text-muted' },
            '—',
            h('span', { class: 'sr-only' }, 'Change unavailable'),
          ),
    );
  };
  const load = async () => {
    const current = ++token;
    refresh.disabled = true;
    render(refresh, icon('refresh-cw', 14, 'animate-spin'));
    render(
      quoteCell,
      h('span', { class: 'sr-only' }, `Loading ${symbol} quote`),
      h('div', { class: 'h-5 w-28 animate-pulse rounded bg-elevated', 'aria-hidden': 'true' }),
      h('p', { class: 'mt-1 text-xs leading-5 text-muted' }, 'Checking the available data source.'),
    );
    let quote = null;
    try {
      quote = await Promise.race([
        fetchQuote(symbol),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15_000)),
      ]);
    } catch {
      quote = null;
    }
    if (current !== token) return;
    const valid = quote?.symbol === symbol ? quote : null;
    const validPrice = valid?.price != null && Number.isFinite(valid.price) && valid.price > 0;
    snapshot = validPrice ? valid : null;
    const source =
      valid?.source === 'kite'
        ? 'Zerodha Kite'
        : valid?.source === 'yahoo'
          ? 'Yahoo Finance'
          : 'Unverified provider';
    render(
      quoteCell,
      validPrice
        ? h('p', { class: 'font-mono tnum' }, priceText(valid))
        : h('p', { class: 'text-muted' }, 'Price unavailable'),
      h(
        'p',
        { class: 'mt-1 text-xs leading-5 text-muted' },
        valid
          ? `${source} snapshot · Provider timestamp unavailable; freshness unverified.`
          : 'Quote could not be verified. Refresh to try again.',
      ),
    );
    paintChange(validPrice ? valid : null);
    refresh.disabled = false;
    render(refresh, icon('refresh-cw', 14));
  };
  refresh.addEventListener('click', () => void load());
  liveUpdaters.set(symbol, (price) => {
    if (!snapshot) return;
    const quote = { ...snapshot, price };
    const time = new Date().toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
    });
    render(
      quoteCell,
      h('p', { class: 'font-mono tnum' }, priceText(quote)),
      h('p', { class: 'mt-1 text-xs leading-5 text-muted' }, `Zerodha Kite live · ${time} IST`),
    );
    paintChange(quote);
  });
  const remove = $('[data-remove]', row);
  remove.addEventListener('click', async () => {
    if (remove.disabled) return;
    remove.disabled = true;
    render(
      remove,
      icon('loader-2', 16, 'animate-spin'),
      h('span', { class: 'sr-only' }, `Removing ${symbol}`),
    );
    try {
      await api(`/api/watchlist/${encodeURIComponent(row.dataset.id)}`, { method: 'DELETE' });
      reloadWith('Removed from watchlist.');
    } catch (error) {
      notifyError(error, 'Could not remove the symbol.');
      remove.disabled = false;
      render(remove, icon('trash-2', 16), h('span', {}, 'Remove'));
    }
  });
  void load();
}

/* ---------------------------------- adding ---------------------------------- */
const form = $('[data-add-form]');
const field = $('[data-symbol-input]');
const manual = $('[data-add-manual]');
let adding = null;
const searchButton = h(
  'button',
  { type: 'button', class: buttonClass('outline', 'default', 'w-full'), disabled: true },
  icon('bot', 16, 'mr-2'),
  'Find by company name',
);
render($('[data-ai-search]'), aiGate(data.health, 'AI symbol search', searchButton));

function paintButtons() {
  const empty = !field.value.trim();
  manual.disabled = adding !== null || empty;
  searchButton.disabled = adding !== null || empty;
  field.disabled = adding !== null;
  render(
    manual,
    adding === 'manual' ? icon('loader-2', 16, 'mr-2 animate-spin') : '',
    adding === 'manual' ? 'Adding symbol…' : 'Add symbol',
  );
  render(
    searchButton,
    icon(
      adding === 'search' ? 'loader-2' : 'bot',
      16,
      adding === 'search' ? 'mr-2 animate-spin' : 'mr-2',
    ),
    'Find by company name',
  );
}

async function add(mode) {
  const query = field.value.trim();
  if (!query || adding) return;
  adding = mode;
  paintButtons();
  try {
    const result = mode === 'search' ? await requestSymbol(query) : query;
    const symbol = result?.trim().toUpperCase();
    if (!symbol) {
      notify('No matching NSE symbol was found for that query.', 'error');
      return;
    }
    if (!NSE_SYMBOL_RE.test(symbol)) {
      notify('Enter a valid NSE symbol, or use company-name search.', 'error');
      return;
    }
    if (watchlist.some((item) => item.symbol === symbol)) {
      notify(`${symbol} is already in your watchlist.`, 'info');
      return;
    }
    await api('/api/watchlist', { method: 'POST', body: { symbol } });
    reloadWith(`Added ${symbol}.`);
    return;
  } catch (error) {
    notifyError(error, 'Could not add the symbol.');
  } finally {
    adding = null;
    paintButtons();
  }
}

field.addEventListener('input', paintButtons);
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void add('manual');
});
searchButton.addEventListener('click', () => void add('search'));
const alerts = createPriceAlerts({ watchlist });
render($('[data-alerts]'), alerts.element);
for (const row of $$('[data-watch-row]')) {
  $('[data-alert]', row).addEventListener('click', () => alerts.prefill(row.dataset.symbol));
}
const liveUpdaters = new Map();
$$('[data-watch-row]').forEach(bindRow);
// Live Zerodha prices when available; otherwise the snapshots above stay as they are.
watchLiveQuotes([...liveUpdaters.keys()], (symbol, price) => liveUpdaters.get(symbol)?.(price));
