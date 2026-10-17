import { describe, expect, it } from 'vitest';
import { fillsToRoundTrips } from '../../shared/broker-fills.js';

let id = 0;
const fill = (side, quantity, price, minute, fields = {}) => ({
  symbol: 'INFY',
  exchange: 'NSE',
  product: 'MIS',
  side,
  quantity,
  averagePrice: price,
  tradeId: `T${String((id += 1)).padStart(3, '0')}`,
  orderId: 'O1',
  filledAt: `2026-10-05T04:${String(minute).padStart(2, '0')}:00.000Z`,
  ...fields,
});

describe('fills to round trips', () => {
  it('pairs partial fills from flat to flat with weighted prices', () => {
    const { trips, open } = fillsToRoundTrips([
      fill('BUY', 10, 100, 1),
      fill('BUY', 30, 104, 2),
      fill('SELL', 25, 110, 3),
      fill('SELL', 15, 112, 4),
    ]);
    expect(open).toEqual([]);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      symbol: 'INFY',
      type: 'Long',
      quantity: 40,
      entryPrice: 103,
      exitPrice: 110.75,
    });
    expect(trips[0].fillIds).toHaveLength(4);
  });

  it('splits a fill that flips the position and reports what stays open', () => {
    const { trips, open } = fillsToRoundTrips([
      fill('SELL', 10, 200, 1),
      fill('BUY', 15, 190, 2), // closes the short, opens a 5-share long
      fill('BUY', 5, 50, 3, { symbol: 'TCS' }),
    ]);
    expect(trips).toEqual([
      expect.objectContaining({ type: 'Short', quantity: 10, entryPrice: 200, exitPrice: 190 }),
    ]);
    expect(open).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'INFY', quantity: 5 }),
        expect.objectContaining({ symbol: 'TCS', quantity: 5 }),
      ]),
    );
  });

  it('keeps products apart, prices F&O by segment and skips other exchanges', () => {
    const { trips, skipped } = fillsToRoundTrips([
      fill('BUY', 1, 100, 1, { product: 'CNC' }),
      fill('SELL', 1, 101, 2, { product: 'MIS' }),
      fill('BUY', 75, 10, 3, { symbol: 'NIFTY26OCT24500CE', exchange: 'NFO', product: 'NRML' }),
      fill('SELL', 75, 12, 4, { symbol: 'NIFTY26OCT24500CE', exchange: 'NFO', product: 'NRML' }),
      fill('BUY', 1, 70, 5, { symbol: 'CRUDEOIL26OCTFUT', exchange: 'MCX' }),
    ]);
    expect(trips).toEqual([
      expect.objectContaining({ symbol: 'NIFTY26OCT24500CE', segment: 'OPT', quantity: 75 }),
    ]);
    expect(skipped).toEqual([expect.objectContaining({ exchange: 'MCX' })]);
  });

  it('keeps a carried position out of today’s round trips', () => {
    // Long 50 carried from yesterday: exit at 24000, then an intraday 24100 → 24150.
    const nifty = { symbol: 'NIFTY26MAYFUT', exchange: 'NFO', product: 'NRML' };
    const { trips, open, skipped } = fillsToRoundTrips(
      [
        fill('SELL', 50, 24000, 1, nifty),
        fill('BUY', 50, 24100, 2, nifty),
        fill('SELL', 50, 24150, 3, nifty),
      ],
      { carried: new Map([['NFO:NIFTY26MAYFUT:NRML', 50]]) },
    );
    expect(trips).toEqual([
      expect.objectContaining({ type: 'Long', quantity: 50, entryPrice: 24100, exitPrice: 24150 }),
    ]);
    expect(open).toEqual([]);
    expect(skipped).toEqual([
      expect.objectContaining({
        symbol: 'NIFTY26MAYFUT',
        quantity: 50,
        reason: expect.stringMatching(/carried/),
      }),
    ]);
  });

  it('sells beyond a holding as a new short and nets today’s lots first', () => {
    const cnc = { product: 'CNC' };
    const { trips, open } = fillsToRoundTrips(
      [fill('BUY', 5, 100, 1, cnc), fill('SELL', 20, 110, 2, cnc), fill('BUY', 5, 105, 3, cnc)],
      { carried: new Map([['NSE:INFY:CNC', 10]]) },
    );
    // 5 bought today close first (intraday), 10 close the holding, 5 open a short that is covered.
    expect(trips).toEqual([
      expect.objectContaining({ type: 'Long', quantity: 5, entryPrice: 100, exitPrice: 110 }),
      expect.objectContaining({ type: 'Short', quantity: 5, entryPrice: 110, exitPrice: 105 }),
    ]);
    expect(open).toEqual([]);
  });

  it('counts the distinct orders on each side for the brokerage cap', () => {
    const { trips } = fillsToRoundTrips([
      fill('BUY', 10, 100, 1, { orderId: 'A' }),
      fill('BUY', 10, 100, 2, { orderId: 'A' }),
      fill('BUY', 10, 101, 3, { orderId: 'B' }),
      fill('SELL', 30, 105, 4, { orderId: 'C' }),
    ]);
    expect(trips[0]).toMatchObject({ entryOrders: 2, exitOrders: 1 });
    const unknown = fillsToRoundTrips([
      fill('BUY', 5, 100, 1, { orderId: undefined }),
      fill('SELL', 5, 101, 2),
    ]);
    expect(unknown.trips[0]).toMatchObject({ entryOrders: null, exitOrders: 1 });
  });
});
