/** Provider-agnostic market data contract. */

export class MarketDataError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = 'MarketDataError';
  }
}

/** Symbols are interpolated into upstream URLs, so the allow-list is strict. */
const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9.\-^=&]{0,29}$/;

/** Upper-cased symbol, or MarketDataError 400 unless it matches the strict symbol allow-list. */
export function assertValidSymbol(value) {
  if (typeof value !== 'string' || !SYMBOL_RE.test(value)) {
    throw new MarketDataError('Invalid or missing "symbol" parameter', 400);
  }
  return value.toUpperCase();
}

/**
 * The history interval, defaulting to '1d'. Throws MarketDataError 400 for anything but 5m, 15m,
 * 1h, 1d, 1wk or 1mo.
 */
export function assertValidInterval(value) {
  if (value === undefined || value === '1d') return '1d';
  if (value === '5m' || value === '15m' || value === '1h' || value === '1wk' || value === '1mo')
    return value;
  throw new MarketDataError('Invalid "interval": expected 5m, 15m, 1h, 1d, 1wk or 1mo', 400);
}

/** Throws MarketDataError 400 when an intraday (5m, 15m, 1h) range spans more than seven days. */
export function assertBoundedIntradayRange(fromSeconds, toSeconds, interval) {
  if (['5m', '15m', '1h'].includes(interval) && toSeconds - fromSeconds > 7 * 86400)
    throw new MarketDataError('Intraday history is limited to seven days per request.', 400);
}

/**
 * Unix seconds for a real YYYY-MM-DD calendar date (UTC midnight). Throws MarketDataError 400 when
 * missing or invalid.
 */
export function assertValidDate(value, field) {
  if (value === undefined) {
    throw new MarketDataError(`Missing "${field}" parameter`, 400);
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new MarketDataError(`Invalid "${field}": expected a date in YYYY-MM-DD format`, 400);
  }
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  // Date.parse normalizes impossible dates such as February 30 into March.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new MarketDataError(`Invalid "${field}": expected a real calendar date`, 400);
  }
  return Math.floor(ms / 1000);
}

/**
 * Throws MarketDataError 400 unless `from` precedes `to`, both are safe integers and neither goes
 * past tomorrow (UTC).
 */
export function assertValidHistoryRange(fromSeconds, toSeconds, now = Date.now()) {
  if (!Number.isSafeInteger(fromSeconds) || !Number.isSafeInteger(toSeconds)) {
    throw new MarketDataError('Invalid historical date range', 400);
  }
  if (toSeconds <= fromSeconds) {
    throw new MarketDataError('"to" must be after "from"', 400);
  }
  // The upstream period2 boundary is exclusive. Tomorrow at UTC midnight lets
  // callers include today's candles, without accepting unbounded future dates.
  // Keep long historical ranges available; there is no product duration cap.
  const daySeconds = 86_400;
  const tomorrowSeconds = (Math.floor(now / (daySeconds * 1000)) + 1) * daySeconds;
  if (fromSeconds >= tomorrowSeconds || toSeconds > tomorrowSeconds) {
    throw new MarketDataError('Historical dates cannot extend beyond tomorrow (UTC)', 400);
  }
}
