// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase, startTestApp, stopTestApp } from '../helpers/app.js';
import { BrokerInstrument, RateWindow } from '../../models/index.js';
import { brokerInstrument } from '../../services/broker/instruments.js';

beforeAll(async () => {
  await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetDatabase);

const master = (count) =>
  Array.from({ length: count }, (_, index) => ({
    exchange: 'NSE',
    symbol: `SYM${index}`,
    token: String(1000 + index),
    lotSize: 1,
    tickSize: 0.05,
  }));
/** Ages every cached row and frees the refresh lock, as if a day had passed. */
async function dayLater(provider) {
  await BrokerInstrument.updateMany(
    { provider },
    { updatedAt: new Date(Date.now() - 2 * 86_400_000) },
  );
  await RateWindow.deleteMany({});
}

describe('broker instrument cache', () => {
  it('loads the master once, in batches, and serves later lookups from the cache', async () => {
    const loadAll = vi.fn(async () => master(2500));
    const row = await brokerInstrument('dhan', 'nse', 'sym2400', loadAll);
    expect(row).toMatchObject({
      _id: 'dhan:NSE:SYM2400',
      provider: 'dhan',
      exchange: 'NSE',
      symbol: 'SYM2400',
      token: '3400',
      lotSize: 1,
      tickSize: 0.05,
    });
    expect(await BrokerInstrument.countDocuments({ provider: 'dhan' })).toBe(2500);
    expect(await brokerInstrument('dhan', 'NSE', 'MISSING', loadAll)).toBeNull();
    expect(loadAll).toHaveBeenCalledOnce();
  });

  it('shares one refresh between concurrent lookups', async () => {
    const loadAll = vi.fn(async () => master(3));
    const rows = await Promise.all(
      ['SYM0', 'SYM1', 'SYM2'].map((symbol) => brokerInstrument('fyers', 'NSE', symbol, loadAll)),
    );
    expect(rows.map((row) => row.token)).toEqual(['1000', '1001', '1002']);
    expect(loadAll).toHaveBeenCalledOnce();
  });

  it('refreshes a day-old cache from an async iterable and drops delisted rows', async () => {
    await brokerInstrument('upstox', 'NSE', 'SYM0', async () => master(3));
    await brokerInstrument('angel', 'NSE', 'SYM0', async () => master(1));
    await dayLater('upstox');
    async function* next() {
      yield { exchange: 'NSE', symbol: 'SYM0', token: '9000', isin: 'INE009A01021' };
      yield { exchange: 'NSE', symbol: '', token: '1' }; // unreadable: skipped
      yield { exchange: 'NSE', symbol: 'NEW', token: 9001 };
    }
    // The lookup answers from the day-old row; the refresh lands behind it.
    expect(await brokerInstrument('upstox', 'NSE', 'SYM0', next)).toMatchObject({ token: '1000' });
    await vi.waitFor(async () =>
      expect(await BrokerInstrument.countDocuments({ provider: 'upstox' })).toBe(2),
    );
    const row = await BrokerInstrument.findById('upstox:NSE:SYM0').lean();
    expect(row).toMatchObject({ token: '9000', isin: 'INE009A01021', lotSize: null });
    const symbols = await BrokerInstrument.find({ provider: 'upstox' }).distinct('symbol');
    expect(symbols.sort()).toEqual(['NEW', 'SYM0']);
    // Other brokers' rows are untouched.
    expect(await BrokerInstrument.countDocuments({ provider: 'angel' })).toBe(1);
  });

  it('keeps the old rows when a refresh fails, and fails without any', async () => {
    const broken = async () => {
      throw new Error('master unreachable');
    };
    await expect(brokerInstrument('dhan', 'NSE', 'SYM0', broken)).rejects.toThrow(
      'master unreachable',
    );
    await RateWindow.deleteMany({});
    await expect(brokerInstrument('dhan', 'NSE', 'SYM0', async () => [])).rejects.toMatchObject({
      status: 502,
    });
    await RateWindow.deleteMany({});
    await brokerInstrument('dhan', 'NSE', 'SYM0', async () => master(2));
    await dayLater('dhan');
    expect(await brokerInstrument('dhan', 'NSE', 'SYM1', broken)).toMatchObject({ token: '1001' });
  });

  it('does not hold a lookup on a day-old cache for the refresh', async () => {
    await brokerInstrument('angel', 'NSE', 'SYM0', async () => master(1));
    await dayLater('angel');
    let release;
    const slow = vi.fn(() => new Promise((resolve) => (release = resolve)));
    expect(await brokerInstrument('angel', 'NSE', 'SYM0', slow)).toMatchObject({ token: '1000' });
    await vi.waitFor(() => expect(slow).toHaveBeenCalledOnce());
    release(master(2));
    await vi.waitFor(async () =>
      expect(await BrokerInstrument.countDocuments({ provider: 'angel' })).toBe(2),
    );
  });

  it('marks a partly loaded first list stale so the next lookup retries', async () => {
    async function* partial() {
      yield* master(1500);
      throw new Error('connection reset');
    }
    await expect(brokerInstrument('fyers', 'NSE', 'SYM0', partial)).rejects.toThrow(
      'connection reset',
    );
    expect(await BrokerInstrument.countDocuments({ provider: 'fyers' })).toBe(1000);
    expect(
      await BrokerInstrument.countDocuments({ provider: 'fyers', updatedAt: { $gt: new Date(0) } }),
    ).toBe(0);
    await RateWindow.deleteMany({});
    const loadAll = vi.fn(async () => master(1500));
    await brokerInstrument('fyers', 'NSE', 'SYM0', loadAll);
    await vi.waitFor(async () =>
      expect(await BrokerInstrument.countDocuments({ provider: 'fyers' })).toBe(1500),
    );
    expect(loadAll).toHaveBeenCalledOnce();
  });

  it('leaves the refresh to the process that holds it', async () => {
    const loadAll = vi.fn(async () => master(1));
    await RateWindow.create({
      _id: 'broker-instruments:kite',
      windowStartedAt: new Date(),
      attempts: 1,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    await expect(brokerInstrument('kite', 'NSE', 'SYM0', loadAll)).rejects.toMatchObject({
      status: 503,
    });
    expect(loadAll).not.toHaveBeenCalled();
  });
});
