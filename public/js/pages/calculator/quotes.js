/**
 * Latest quote for the selected symbol (fills the entry price) and symbol changes.
 */
import { NSE_SYMBOL_RE } from '../../../../shared/ai-schemas.js';
import { fetchQuote } from '../../lib/quotes.js';
import { setEntry } from './fields.js';
import { paintEstimate, paintQuote } from './painting.js';
import { state } from './shared.js';

let quoteToken = 0;
/**
 * Fetches a reference quote for the current symbol (15s timeout) and fills the entry
 * price unless the user typed one. Stale responses from earlier symbols are dropped.
 */
export async function loadQuote() {
  const symbol = state.symbol.trim().toUpperCase();
  const token = ++quoteToken;
  state.quote = null;
  if (!NSE_SYMBOL_RE.test(symbol)) {
    state.quoteState = '';
    paintQuote();
    return;
  }
  state.quoteState = 'Checking available quote…';
  paintQuote();
  try {
    const value = await Promise.race([
      fetchQuote(symbol),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15_000)),
    ]);
    if (token !== quoteToken) return;
    if (
      value.symbol !== symbol ||
      value.currency !== 'INR' ||
      value.price === null ||
      !Number.isFinite(value.price) ||
      value.price <= 0
    ) {
      state.quoteState = 'No verified INR price available. Enter the planned entry manually.';
    } else {
      state.quote = {
        symbol: value.symbol,
        price: value.price,
        currency: value.currency,
        source: value.source,
        asOf: null,
        fetchedAt: new Date().toISOString(),
      };
      state.quoteState = `${value.source === 'kite' ? 'Zerodha Kite' : value.source === 'yahoo' ? 'Yahoo Finance' : 'Unverified provider'} · INR · Provider timestamp unavailable; freshness unverified.`;
      if (!state.entryEdited) setEntry(String(value.price));
    }
  } catch {
    if (token !== quoteToken) return;
    state.quoteState = 'Quote unavailable. Enter the planned entry manually.';
  }
  paintQuote();
  paintEstimate();
}

/** Switches the symbol: clears the entry price, starts a quote load and repaints. */
export function setSymbol(symbol) {
  state.symbol = symbol;
  state.entryEdited = false;
  setEntry('');
  void loadQuote();
  paintEstimate();
}
