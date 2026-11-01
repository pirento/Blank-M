// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase, startTestApp, stopTestApp } from '../helpers/app.js';
import { Instrument } from '../../models/index.js';
import { refreshInstruments } from '../../services/market/instruments.js';

beforeAll(async () => {
  await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

const csv = (rows) =>
  [
    'instrument_token,exchange_token,tradingsymbol,name,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
    ...rows.map(([token, symbol]) => `${token},1,${symbol},${symbol},,0,0.05,1,EQ,NSE,NSE`),
  ].join('\n');
const serve = (body) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body)),
  );

describe('Kite instrument master', () => {
  it('drops rows the new master no longer lists, so a re-tokened symbol has one row', async () => {
    serve(
      csv([
        [101, 'ALPHA'],
        [102, 'BETA'],
      ]),
    );
    expect(await refreshInstruments()).toBe(2);
    // BETA gets a new token; ALPHA is delisted.
    serve(csv([[202, 'BETA']]));
    expect(await refreshInstruments()).toBe(1);
    const rows = await Instrument.find({}, { tradingSymbol: 1, instrumentToken: 1 }).lean();
    expect(rows).toEqual([{ _id: '202', tradingSymbol: 'BETA', instrumentToken: 202 }]);
  });

  it('keeps the old rows when the refresh fails part way', async () => {
    serve(csv([[101, 'ALPHA']]));
    await refreshInstruments();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(refreshInstruments()).rejects.toThrow();
    expect(await Instrument.countDocuments()).toBe(1);
  });
});
