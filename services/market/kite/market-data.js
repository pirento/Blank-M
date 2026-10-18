/**
 * Kite market data provider: cached quotes and historical candles, resolving
 * NSE symbols to instrument tokens via the instrument master.
 */
import { Instrument } from '../../../models/index.js';
import { cacheGet, cacheSet } from '../cache.js';
import { refreshInstrumentsIfStale } from '../instruments.js';
import { MarketDataError, assertValidSymbol } from '../types.js';
import { kiteFetch } from './client.js';
import { activeConnection } from './connection.js';

const QUOTE_TTL_MS = 15_000;
// After Kite refuses market data (an app without the quotes/historical
// add-on), skip it for a while instead of asking on every quote. The refusal is
// per Kite app (one for the whole server), so the pause is too; kept short so an
// upgraded app is picked up without a restart.
const DENIED_PAUSE_MS = 30 * 60_000;
let marketDataDeniedUntil = 0;

async function guarded(read) {
  try {
    return await read();
  } catch (error) {
    if (error?.permissionDenied) marketDataDeniedUntil = Date.now() + DENIED_PAUSE_MS;
    throw error;
  }
}

/** Test hook: forget an earlier market-data refusal. */
export function resetKiteMarketDataPause() {
  marketDataDeniedUntil = 0;
}
const HISTORY_TTL_MS = 5 * 60_000;

/** Kite instrument token for an NSE symbol (refreshing the instrument master once if missing), or null. */
export async function instrumentToken(symbol) {
  const find = async () => {
    const data = await Instrument.findOne({ exchange: 'NSE', tradingSymbol: symbol }).lean();
    return typeof data?.instrumentToken === 'number' ? data.instrumentToken : null;
  };
  let token = await find();
  if (token === null) {
    await refreshInstrumentsIfStale();
    token = await find();
  }
  return token;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatKiteDate(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

const INTERVAL_FOR = {
  '1d': 'day',
  '5m': '5minute',
  '15m': '15minute',
  '1h': '60minute',
};

export const kiteProvider = {
  name: 'kite',
  async isAvailable(userId) {
    if (Date.now() < marketDataDeniedUntil) return false;
    return (await activeConnection(userId)) !== null;
  },
  async fetchQuote(rawSymbol, userId) {
    const symbol = assertValidSymbol(rawSymbol);
    const token = await activeConnection(userId);
    if (!token || !userId) throw new MarketDataError('No active Zerodha session', 401);
    const cacheKey = `kite:quote:${symbol}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const key = `NSE:${symbol}`;
    const payload = await guarded(() =>
      kiteFetch(`/quote?i=${encodeURIComponent(key)}`, token, userId),
    );

    const item = payload.data?.[key];
    const quote = {
      symbol,
      price: number(item?.last_price),
      previousClose: number(item?.ohlc?.close),
      currency: 'INR',
      source: 'kite',
    };
    cacheSet(cacheKey, quote, QUOTE_TTL_MS);
    return quote;
  },
  async fetchHistory(rawSymbol, fromSeconds, toSeconds, interval, userId) {
    const symbol = assertValidSymbol(rawSymbol);
    if (toSeconds <= fromSeconds) throw new MarketDataError('"to" must be after "from"', 400);
    const kiteInterval = INTERVAL_FOR[interval];
    if (!kiteInterval) {
      // Kite documents day and intraday candles, not week/month. The caller can use Yahoo.
      throw new MarketDataError('This historical interval is not available from Zerodha.', 422);
    }
    const accessToken = await activeConnection(userId);
    if (!accessToken || !userId) throw new MarketDataError('No active Zerodha session', 401);
    const token = await instrumentToken(symbol);
    if (token === null) throw new MarketDataError(`${symbol} is not in the instrument master`, 404);
    const cacheKey = `kite:history:${symbol}:${fromSeconds}:${toSeconds}:${interval}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const params = new URLSearchParams({
      from: formatKiteDate(fromSeconds),
      to: formatKiteDate(toSeconds),
      continuous: '0',
      oi: '0',
    });
    const payload = await guarded(() =>
      kiteFetch(
        `/instruments/historical/${token}/${kiteInterval}?${params.toString()}`,
        accessToken,
        userId,
      ),
    );
    const candles = (payload.data?.candles || []).flatMap((row) => {
      const [date, open, high, low, close, volume] = row;
      const time = typeof date === 'string' ? Date.parse(date) : NaN;
      const values = [open, high, low, close].map(number);
      if (!Number.isFinite(time) || values.some((value) => value === null)) return [];
      return [
        {
          time,
          open: values[0],
          high: values[1],
          low: values[2],
          close: values[3],
          volume: number(volume) || 0,
        },
      ];
    });
    if (!candles.length) throw new MarketDataError('No historical data for this range.', 404);
    const result = { symbol, candles, source: 'kite' };
    cacheSet(cacheKey, result, HISTORY_TTL_MS);
    return result;
  },
};
