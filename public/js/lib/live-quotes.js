/**
 * Live Zerodha prices over Server-Sent Events (/api/quotes/stream). Works only
 * when the member's Kite app includes market data; otherwise the server sends
 * `unavailable`, the browser stops asking and the page keeps its own refresh.
 * A free member is refused (402, live prices are Premium) and told so.
 */
import { pageData } from '../core/dom.js';
import { t } from '../core/i18n.js';

/**
 * Calls `onPrice(symbol, price, at)` for each live price (`at`: trade time in ms); returns a
 * function that stops it.
 */
export function watchLiveQuotes(symbols, onPrice) {
  if (!symbols.length || typeof EventSource === 'undefined') return () => undefined;
  const source = new EventSource(
    `/api/quotes/stream?symbols=${encodeURIComponent(symbols.join(','))}`,
  );
  source.addEventListener('message', (event) => {
    let tick;
    try {
      tick = JSON.parse(event.data);
    } catch {
      return;
    }
    if (symbols.includes(tick?.symbol) && Number.isFinite(tick.price) && tick.price > 0) {
      onPrice(tick.symbol, tick.price, Number.isFinite(tick.at) ? tick.at : Date.now());
    }
  });
  source.addEventListener('unavailable', () => source.close());
  // EventSource hides the status: a refused stream is one that closed for good. For a free member
  // that is the 402 (network drops reconnect instead).
  source.addEventListener('error', () => {
    const membership = pageData()?.membership;
    if (
      source.readyState === EventSource.CLOSED &&
      membership?.billingEnabled &&
      !membership.premium
    ) {
      // Loaded on demand: chart code using this module is also loaded without a DOM (Node tests).
      void import('../core/toast.js').then(({ notify }) =>
        notify(
          t(
            'Live prices are part of Premium, so these prices are delayed. Open Billing to upgrade.',
          ),
        ),
      );
    }
  });
  return () => source.close();
}
