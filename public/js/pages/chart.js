/**
 * Live chart page: a TradingView-style chart for one symbol (from ?symbol=, else the first
 * watchlist symbol) that follows live prices, with a symbol box to switch.
 */
import { $, pageData } from '../core/dom.js';
import { createProChart } from '../components/pro-chart.js';

const data = pageData();
const form = $('[data-chart-form]');
const field = $('#chart-symbol');
const fromUrl = new URLSearchParams(window.location.search).get('symbol');
// RELIANCE resolves on every price source (index names like NIFTY differ between them).
const first = (fromUrl || data.workspace?.watchlist?.[0]?.symbol || 'RELIANCE')
  .trim()
  .toUpperCase();
field.value = first;

const chart = createProChart({ accountId: data.accountId, symbol: first, initialInterval: '5m' });
$('[data-chart]').append(chart.element);
void chart.load();

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const symbol = field.value.trim().toUpperCase();
  if (!symbol) return;
  field.value = symbol;
  // Keep the address shareable and the back button working.
  window.history.replaceState(null, '', `/chart?symbol=${encodeURIComponent(symbol)}`);
  chart.setSymbol(symbol);
});
window.addEventListener('pagehide', () => chart.stop());
// Coming back from the browser's back/forward cache: follow live prices again.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void chart.load();
});
