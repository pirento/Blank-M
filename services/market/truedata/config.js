/**
 * TrueData (truedata.in) licensed market data: one platform login for live prices and history for
 * every member. Credentials are set in the admin panel → Integrations → Live market data.
 *
 * Showing this data to members needs TrueData's and the exchanges' written permission
 * (redistribution licence); the integration only works once that is in place.
 */

/** Whether a TrueData login is set. */
export function isTrueDataConfigured() {
  return Boolean(process.env.TRUEDATA_USER?.trim() && process.env.TRUEDATA_PASSWORD?.trim());
}

/** Our index symbols → TrueData's names; everything else (NSE equity) is the same. */
const INDEX_NAMES = {
  NIFTY: 'NIFTY 50',
  NIFTY50: 'NIFTY 50',
  BANKNIFTY: 'NIFTY BANK',
  FINNIFTY: 'NIFTY FIN SERVICE',
  INDIAVIX: 'INDIA VIX',
};

/** TrueData's name for one of our symbols. */
export const toTrueDataSymbol = (symbol) => INDEX_NAMES[symbol] ?? symbol;

/** Our symbol for a TrueData name (the reverse of toTrueDataSymbol). */
export function fromTrueDataSymbol(name) {
  const entry = Object.entries(INDEX_NAMES).find(([, value]) => value === name);
  return entry ? entry[0] : name;
}

/**
 * TrueData times are IST without a zone ("2026-10-20T09:15:00"); returns epoch milliseconds, or
 * NaN when the text is not a time.
 */
export function istToMillis(text) {
  const value = String(text);
  // EOD bars may carry only the date.
  const time = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value.slice(0, 19);
  return Date.parse(`${time}+05:30`);
}

/** LiveQuote id of the feed's heartbeat (a colon never appears in a symbol). */
export const FEED_HEARTBEAT_ID = ':feed';
