// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase, startTestApp, stopTestApp } from '../helpers/app.js';
import { LiveQuote, LiveSubscription } from '../../models/index.js';
import { readFeedMessage, startTrueDataFeed } from '../../services/market/truedata/feed.js';
import { readBars } from '../../services/market/truedata/history.js';
import { subscribeVendorQuotes, vendorQuote } from '../../services/market/vendor-quotes.js';
import { applyLivePrice } from '../../public/js/components/market-history-chart.js';

beforeAll(async () => {
  await startTestApp();
  Object.assign(process.env, { TRUEDATA_USER: 'td-user', TRUEDATA_PASSWORD: 'td-pass' });
});
afterAll(async () => {
  delete process.env.TRUEDATA_USER;
  delete process.env.TRUEDATA_PASSWORD;
  await stopTestApp();
});
beforeEach(resetDatabase);

describe('TrueData parsing', () => {
  it('reads subscribe replies, trades and history bars in IST', () => {
    const ids = new Map();
    const seeded = readFeedMessage(
      { symbollist: [['NIFTY 50', '100', '2026-10-20T09:20:00', 24500.5]] },
      ids,
    );
    expect(seeded).toEqual([
      { symbol: 'NIFTY', price: 24500.5, at: Date.parse('2026-10-20T03:50:00Z') },
    ]);
    expect(
      readFeedMessage({ trade: ['100', '2026-10-20T09:21:00', '24510'] }, ids)[0],
    ).toMatchObject({
      symbol: 'NIFTY',
      price: 24510,
    });
    expect(readFeedMessage({ trade: ['999', '2026-10-20T09:21:00', '1'] }, ids)).toEqual([]);
    expect(readBars({ Records: [['2026-10-20T09:15:00', 100, 105, 99, 104, 1200, 0]] })[0]).toEqual(
      {
        time: Date.parse('2026-10-20T03:45:00Z'),
        open: 100,
        high: 105,
        low: 99,
        close: 104,
        volume: 1200,
      },
    );
  });

  it('moves the last candle with live prices and starts a new one after the interval', () => {
    const start = Date.parse('2026-10-20T03:45:00Z');
    const candles = [{ time: start, open: 100, high: 101, low: 99, close: 100, volume: 10 }];
    applyLivePrice(candles, '5m', 103, start + 60_000);
    expect(candles.at(-1)).toMatchObject({ close: 103, high: 103 });
    applyLivePrice(candles, '5m', 102, start + 11 * 60_000);
    expect(candles).toHaveLength(2);
    expect(candles.at(-1)).toMatchObject({ time: start + 10 * 60_000, open: 102 });
  });
});

describe('shared live feed', () => {
  it('subscribes what pages watch and fans prices out through MongoDB', async () => {
    const sockets = [];
    class FakeSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.sent = [];
        sockets.push(this);
        queueMicrotask(() =>
          this.onmessage({
            data: JSON.stringify({ success: true, message: 'TrueData Real Time Data Service' }),
          }),
        );
      }
      send(text) {
        this.sent.push(JSON.parse(text));
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    // A page starts watching RELIANCE; the feed subscribes to it and its prices reach the page.
    const ticks = [];
    const stopWatching = await subscribeVendorQuotes(['RELIANCE'], {
      onTick: (tick) => ticks.push(tick),
    });
    expect(await LiveSubscription.exists({ _id: 'RELIANCE' })).toBeTruthy();

    const feed = startTrueDataFeed({ WebSocketImpl: FakeSocket });
    await vi.waitFor(
      () => expect(sockets[0]?.sent).toContainEqual({ method: 'addsymbol', symbols: ['RELIANCE'] }),
      { timeout: 8000 },
    );
    expect(sockets[0].url).toContain('user=td-user');
    sockets[0].onmessage({
      data: JSON.stringify({ symbollist: [['RELIANCE', '7', '2026-10-20T09:20:00', 2900]] }),
    });
    sockets[0].onmessage({
      data: JSON.stringify({
        trade: ['7', new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 19), 2905.5],
      }),
    });
    await vi.waitFor(
      async () => expect((await LiveQuote.findById('RELIANCE').lean())?.price).toBe(2905.5),
      { timeout: 5000 },
    );
    await vi.waitFor(() => expect(ticks.at(-1)).toEqual({ symbol: 'RELIANCE', price: 2905.5 }), {
      timeout: 5000,
    });
    expect(await vendorQuote('RELIANCE')).toMatchObject({ price: 2905.5, source: 'truedata' });

    stopWatching();
    feed.stop();
  }, 20_000);
});
