/**
 * Live Zerodha prices over Server-Sent Events (/api/quotes/stream). Works only
 * when the member's Kite app includes market data; otherwise the server sends
 * `unavailable`, the browser stops asking and the page keeps its own refresh.
 */

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
  return () => source.close();
}
