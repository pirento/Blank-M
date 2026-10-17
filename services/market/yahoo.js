/**
 * Yahoo Finance chart endpoint.
 *
 * Undocumented and rate limited, which is precisely why it now sits behind the
 * MarketDataProvider interface as the *fallback*: it needs no credentials, so
 * the app keeps working when Kite is unconfigured or its daily session has
 * expired. Everything that knows this URL shape lives in this file.
 */
import { HISTORY_TTL_MS, QUOTE_TTL_MS, cacheGet, cacheSet } from './cache.js';
import { MarketDataError, assertValidSymbol } from './types.js';

const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TIMEOUT_MS = 8000;

/** Yahoo needs an exchange suffix for Indian listings. */
export function toYahooSymbol(symbol) {
  const upper = symbol.toUpperCase();
  return upper.includes('.') || upper.startsWith('^') ? upper : `${upper}.NS`;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: {
        // Yahoo rejects requests without a browser-like UA.
        'User-Agent': 'Mozilla/5.0 (compatible; BlankTradingJournal/0.2)',
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new MarketDataError(
        `Market data provider returned ${response.status}`,
        // Forward rate limiting so the client can back off; collapse the rest
        // into 502, since an upstream 404 is not a 404 of our own API.
        response.status === 429 ? 429 : 502,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof MarketDataError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MarketDataError('Market data provider timed out', 504);
    }
    throw new MarketDataError('Could not reach the market data provider', 502);
  } finally {
    clearTimeout(timer);
  }
}

export const yahooProvider = {
  name: 'yahoo',

  // No credentials, so it is always available.
  async isAvailable() {
    return true;
  },

  async fetchQuote(rawSymbol) {
    const symbol = assertValidSymbol(rawSymbol);
    const key = `yahoo:quote:${symbol}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const url = `${CHART_BASE}/${encodeURIComponent(toYahooSymbol(symbol))}?range=1d&interval=1d`;
    const meta = readChartMeta(await fetchJson(url));

    const quote = {
      symbol,
      price: numberOrNull(meta?.regularMarketPrice),
      previousClose: numberOrNull(meta?.chartPreviousClose ?? meta?.previousClose),
      currency: typeof meta?.currency === 'string' ? meta.currency : null,
      source: 'yahoo',
    };
    cacheSet(key, quote, QUOTE_TTL_MS);
    return quote;
  },

  async fetchHistory(rawSymbol, fromSeconds, toSeconds, interval) {
    const symbol = assertValidSymbol(rawSymbol);
    if (toSeconds <= fromSeconds) {
      throw new MarketDataError('"to" must be after "from"', 400);
    }

    const key = `yahoo:history:${symbol}:${fromSeconds}:${toSeconds}:${interval}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const url =
      `${CHART_BASE}/${encodeURIComponent(toYahooSymbol(symbol))}` +
      `?period1=${fromSeconds}&period2=${toSeconds}&interval=${interval === '1h' ? '60m' : interval}`;
    const payload = await fetchJson(url);
    const candles = readCandles(payload);

    if (candles.length === 0) {
      throw new MarketDataError(`No historical data available for ${symbol} in that range`, 404);
    }

    const currency = readChartMeta(payload)?.currency;
    const result = {
      symbol,
      candles,
      source: 'yahoo',
      currency: typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : null,
    };
    cacheSet(key, result, HISTORY_TTL_MS);
    return result;
  },
};

/* ---------------- response parsing (Yahoo's payload is loosely typed) --------------- */

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readChartResult(payload) {
  if (typeof payload !== 'object' || payload === null) return null;
  const chart = payload.chart;
  if (typeof chart !== 'object' || chart === null) return null;
  const results = chart.result;
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = results[0];
  return typeof first === 'object' && first !== null ? first : null;
}

function readChartMeta(payload) {
  const result = readChartResult(payload);
  if (!result) return null;
  const meta = result.meta;
  return typeof meta === 'object' && meta !== null ? meta : null;
}

function readCandles(payload) {
  const result = readChartResult(payload);
  if (!result) return [];

  const timestamps = result.timestamp;
  if (!Array.isArray(timestamps)) return [];

  const indicators = result.indicators;
  if (typeof indicators !== 'object' || indicators === null) return [];
  const quotes = indicators.quote;
  if (!Array.isArray(quotes) || quotes.length === 0) return [];
  const quote = quotes[0];
  if (typeof quote !== 'object' || quote === null) return [];

  const series = quote;
  const open = asNumberArray(series.open);
  const high = asNumberArray(series.high);
  const low = asNumberArray(series.low);
  const close = asNumberArray(series.close);
  const volume = asNumberArray(series.volume);

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const time = timestamps[i];
    const o = open[i];
    const h = high[i];
    const l = low[i];
    const c = close[i];
    // Yahoo pads gaps with nulls; a candle missing any leg is unusable.
    if (typeof time !== 'number' || o == null || h == null || l == null || c == null) continue;
    candles.push({ time: time * 1000, open: o, high: h, low: l, close: c, volume: volume[i] ?? 0 });
  }
  return candles;
}

function asNumberArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === 'number' && Number.isFinite(entry) ? entry : null));
}
