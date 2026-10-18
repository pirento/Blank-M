/**
 * Loads and validates price history for the market chart.
 */
import { z } from 'zod';
import { requestHeaders } from '../core/api.js';

export const CHART_INTERVALS = ['5m', '15m', '1h', '1d'];

const MAX_CANDLES = 3000;
const MAX_BYTES = 1024 * 1024;
const price = z
  .number()
  .positive()
  .finite()
  .max(Number.MAX_SAFE_INTEGER / 100);
const candleSchema = z
  .object({
    time: z.number().int().nonnegative().max(8.64e15),
    open: price,
    high: price,
    low: price,
    close: price,
    volume: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((c) => c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close));
const historySchema = z.object({
  symbol: z.string(),
  source: z.enum(['kite', 'yahoo']),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  candles: z.array(candleSchema).min(1).max(MAX_CANDLES),
});

/**
 * UTC `{ from, to }` dates (YYYY-MM-DD) to request: the last 180 days for '1d', else 7 days,
 * with `to` the day after today so today's candles are included.
 */
export function chartRange(interval, now = Date.now()) {
  const day = 86400_000;
  const end = (Math.floor(now / day) + 1) * day;
  const start = end - (interval === '1d' ? 180 : 7) * day;
  return {
    from: new Date(start).toISOString().slice(0, 10),
    to: new Date(end).toISOString().slice(0, 10),
  };
}

/**
 * Check a history payload against the schema, the requested symbol and range: candles must be
 * in strictly ascending time, inside the range and not in the future. Returns it or throws.
 */
export function validateChartHistory(payload, symbol, range, now = Date.now()) {
  const parsed = historySchema.safeParse(payload);
  if (!parsed.success || parsed.data.symbol !== symbol)
    throw new Error('Chart data could not be verified.');
  const candles = parsed.data.candles;
  const start = Date.parse(`${range.from}T00:00:00Z`);
  const end = Date.parse(`${range.to}T00:00:00Z`);
  if (
    candles.some(
      (c, i) =>
        c.time < start || c.time >= end || c.time > now || (i > 0 && c.time <= candles[i - 1].time),
    )
  )
    throw new Error('Chart data could not be verified.');
  return parsed.data;
}

/** Exact-owner reads, with a bounded body and cancellation before and after the request. */
export async function fetchChartHistory(
  accountId,
  symbol,
  interval,
  signal,
  range = chartRange(interval),
) {
  if (!/^[A-Z0-9][A-Z0-9.\-^=&]{0,29}$/.test(symbol)) throw new Error('Select a valid instrument.');
  signal.throwIfAborted();
  if (!accountId) throw new Error('Sign in again to load the chart.');
  const params = new URLSearchParams({ symbol, interval, ...range });
  // The session identity header binds this read to the login that rendered the page.
  const response = await fetch(`/api/history?${params}`, {
    signal,
    cache: 'no-store',
    redirect: 'error',
    credentials: 'same-origin',
    headers: requestHeaders(false),
  });
  if (response.status === 409) throw new Error('Your account changed. Load the chart again.');
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
    throw new Error(
      response.status === 429
        ? 'Chart requests are limited. Try again later.'
        : 'Chart history is unavailable. Try again.',
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Chart history is unavailable. Try again.');
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Chart response is too large.');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('Chart data could not be verified.');
  }
  return validateChartHistory(payload, symbol, range);
}
