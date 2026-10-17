import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chartRange,
  fetchChartHistory,
  validateChartHistory,
} from '../../public/js/lib/market-chart.js';
const now = Date.parse('2026-10-09T10:00:00Z');
const range = { from: '2026-10-03', to: '2026-10-10' };
const candle = { time: now - 86400_000, open: 100, high: 110, low: 99, close: 105, volume: 1000 };
const payload = () => ({
  symbol: 'INFY',
  source: 'yahoo',
  currency: 'INR',
  candles: [{ ...candle }],
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  document.head.innerHTML =
    '<meta name="csrf-token" content="csrf"><meta name="blank-session" content="session-a">';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(payload())),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('bounded historical chart data', () => {
  it('requests seven-day intraday and 180-day daily snapshots through tomorrow UTC', () => {
    expect(chartRange('5m', now)).toEqual(range);
    expect(chartRange('1h', now)).toEqual(range);
    const daily = chartRange('1d', now);
    expect(Date.parse(daily.to) - Date.parse(daily.from)).toBe(180 * 86400_000);
  });
  it('preserves actual source, currency and raw candle prices', () => {
    expect(validateChartHistory(payload(), 'INFY', range, now)).toEqual(payload());
  });
  it.each([
    { symbol: 'OTHER' },
    { source: 'invented' },
    { currency: 'rupees' },
    { candles: [] },
    { candles: [{ ...candle, high: 101 }] },
    { candles: [{ ...candle, open: -1 }] },
    { candles: [{ ...candle, low: 106 }] },
    { candles: [{ ...candle, volume: -1 }] },
    { candles: [{ ...candle, close: Number.MAX_VALUE }] },
    { candles: [{ ...candle, time: now + 1 }] },
    { candles: [{ ...candle, time: Date.parse(range.to) }] },
    { candles: [{ ...candle, time: Date.parse(range.from) - 1 }] },
    { candles: [candle, candle] },
    { candles: [{ ...candle, time: now }, candle] },
  ])('rejects unverifiable or mislabelled history: %j', (change) => {
    expect(() => validateChartHistory({ ...payload(), ...change }, 'INFY', range, now)).toThrow(
      'could not be verified',
    );
  });
  it('binds the read to the rendering login session, retains cancellation and bounds dates', async () => {
    const signal = new AbortController().signal;
    await expect(fetchChartHistory('owner', 'INFY', '5m', signal)).resolves.toEqual(payload());
    expect(fetch).toHaveBeenCalledWith(
      '/api/history?symbol=INFY&interval=5m&from=2026-10-03&to=2026-10-10',
      expect.objectContaining({
        signal,
        cache: 'no-store',
        redirect: 'error',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-Blank-Session': 'session-a' }),
      }),
    );
  });
  it('does not send a request without a signed-in account', async () => {
    await expect(fetchChartHistory('', 'INFY', '1d', new AbortController().signal)).rejects.toThrow(
      'Sign in again',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a response after the account changes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ error: 'Your app session changed.' }, { status: 409 }),
    );
    await expect(
      fetchChartHistory('owner', 'INFY', '1d', new AbortController().signal),
    ).rejects.toThrow('account changed');
  });
  it('stops before the request when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchChartHistory('owner', 'INFY', '1d', controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('redacts upstream error payloads and fails on HTML success', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ error: 'private diagnostic' }, { status: 500 }))
      .mockResolvedValueOnce(
        new Response('<html>private diagnostic</html>', {
          headers: { 'content-type': 'text/html' },
        }),
      );
    for (let i = 0; i < 2; i++)
      await expect(
        fetchChartHistory('owner', 'INFY', '1d', new AbortController().signal),
      ).rejects.toThrow('Chart history is unavailable');
  });
  it('limits the decoded response body before parsing untrusted history', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(' '.repeat(1024 * 1024 + 1), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      fetchChartHistory('owner', 'INFY', '1d', new AbortController().signal),
    ).rejects.toThrow('too large');
  });
});
