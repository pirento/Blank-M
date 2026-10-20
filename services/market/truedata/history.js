/**
 * TrueData historical bars (https://history.truedata.in/getbars) as our candles. Token from
 * https://auth.truedata.in/token, cached until shortly before it expires.
 */
import { MarketDataError, assertValidSymbol } from '../types.js';
import { istToMillis, toTrueDataSymbol } from './config.js';

const TIMEOUT_MS = 15_000;
const INTERVALS = { '5m': '5min', '15m': '15min', '1h': '60min', '1d': 'EOD' };
let token = null;

async function accessToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const response = await fetch('https://auth.truedata.in/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: process.env.TRUEDATA_USER.trim(),
      password: process.env.TRUEDATA_PASSWORD.trim(),
      grant_type: 'password',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  const payload = await response?.json().catch(() => null);
  if (!response?.ok || typeof payload?.access_token !== 'string') {
    throw new MarketDataError('TrueData sign-in failed. Check the login in the admin panel.', 502);
  }
  token = {
    value: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
  };
  return token.value;
}

/** "YYMMDDTHH:mm:ss" in IST for epoch seconds. */
function trueDataTime(seconds) {
  const ist = new Date(seconds * 1000 + 330 * 60_000).toISOString();
  return `${ist.slice(2, 4)}${ist.slice(5, 7)}${ist.slice(8, 10)}T${ist.slice(11, 19)}`;
}

/** Candles `{ time (ms), open, high, low, close, volume }` from a getbars JSON reply. */
export function readBars(payload) {
  const records = Array.isArray(payload?.Records) ? payload.Records : [];
  return records
    .map(([time, open, high, low, close, volume]) => ({
      time: istToMillis(time),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Math.max(0, Math.round(Number(volume) || 0)),
    }))
    .filter(
      (candle) =>
        Number.isFinite(candle.time) &&
        [candle.open, candle.high, candle.low, candle.close].every((value) => value > 0),
    );
}

export const trueDataProvider = {
  name: 'truedata',

  /** Price history for one of our symbols; same shape as the other providers. */
  async fetchHistory(rawSymbol, fromSeconds, toSeconds, interval) {
    const symbol = assertValidSymbol(rawSymbol);
    const bars = INTERVALS[interval];
    if (!bars) throw new MarketDataError('TrueData has no such interval.', 400);
    const url = new URL('https://history.truedata.in/getbars');
    url.searchParams.set('symbol', toTrueDataSymbol(symbol));
    url.searchParams.set('from', trueDataTime(fromSeconds));
    url.searchParams.set('to', trueDataTime(toSeconds));
    url.searchParams.set('interval', bars);
    url.searchParams.set('response', 'json');
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    if (response?.status === 429) throw new MarketDataError('TrueData rate limit reached.', 429);
    const payload = await response?.json().catch(() => null);
    const candles = response?.ok ? readBars(payload) : [];
    if (!candles.length) {
      throw new MarketDataError(`No TrueData history for ${symbol} in that range`, 404);
    }
    return { symbol, candles, source: 'truedata', currency: 'INR' };
  },
};
