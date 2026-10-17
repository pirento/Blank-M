import { describe, expect, it } from 'vitest';
import { detectTradebook, tradebookToRoundTrips } from '../../shared/tradebook.js';

const ZERODHA = [
  'symbol',
  'isin',
  'trade_date',
  'exchange',
  'segment',
  'series',
  'trade_type',
  'quantity',
  'price',
  'trade_id',
  'order_id',
  'order_execution_time',
];
const zerodhaRow = (symbol, date, side, quantity, price, id, time, fields = {}) => [
  symbol,
  'INE000000000',
  date,
  fields.exchange ?? 'NSE',
  fields.segment ?? 'EQ',
  'EQ',
  side,
  String(quantity),
  String(price),
  String(id),
  '1',
  `${date}T${time}`,
];

describe('tradebook detection', () => {
  it('recognises fill-per-row exports from Zerodha, Upstox, Angel One and Dhan', () => {
    expect(detectTradebook(ZERODHA)).not.toBeNull();
    expect(
      detectTradebook([
        'Date',
        'Company',
        'Amount',
        'Exchange',
        'Segment',
        'Scrip Code',
        'Instrument Type',
        'Strike Price',
        'Expiry',
        'Trade Num',
        'Trade Time',
        'Side',
        'Quantity',
        'Price',
      ]),
    ).toMatchObject({ date: 0, symbol: 1, side: 11, quantity: 12, price: 13, tradeId: 9 });
    expect(
      detectTradebook(['Trade Date', 'Symbol', 'Exchange', 'Buy/Sell', 'Qty', 'Trade Price']),
    ).not.toBeNull();
    expect(
      detectTradebook([
        'Date',
        'Time',
        'Name',
        'Buy/Sell',
        'Exchange',
        'Segment',
        'Quantity/Lot',
        'Trade Price',
        'Trade Value',
      ]),
    ).toMatchObject({ date: 0, time: 1, symbol: 2, side: 3, quantity: 6, price: 7 });
  });

  it('leaves round-trip files to the normal mapping', () => {
    expect(detectTradebook(['Date', 'Symbol', 'Type', 'Entry', 'Exit', 'Qty'])).toBeNull();
    expect(
      detectTradebook(['Date', 'Symbol', 'Side', 'Qty', 'Buy Price', 'Sell Price']),
    ).toBeNull();
    expect(detectTradebook(['Date', 'Symbol', 'Side', 'Qty'])).toBeNull();
  });
});

describe('tradebook to round trips', () => {
  it('pairs a day’s fills per symbol and keeps time order', () => {
    const result = tradebookToRoundTrips(ZERODHA, [
      // Out of file order: the sell happened after both buys.
      zerodhaRow('INFY', '2026-05-04', 'sell', 15, 1520, 3, '10:30:00'),
      zerodhaRow('INFY', '2026-05-04', 'buy', 10, 1500, 1, '09:20:00'),
      zerodhaRow('INFY', '2026-05-04', 'buy', 5, 1506, 2, '09:45:00'),
      zerodhaRow('TCS', '2026-05-04', 'sell', 2, 3500, 4, '11:00:00'),
      zerodhaRow('TCS', '2026-05-04', 'buy', 2, 3480, 5, '14:00:00'),
    ]);
    expect(result.headers).toEqual(['Date', 'Symbol', 'Type', 'Entry', 'Exit', 'Qty', 'Notes']);
    expect(result.fills).toBe(5);
    expect(result.open).toEqual([]);
    expect(result.rows).toEqual([
      ['2026-05-04', 'INFY', 'Long', '1502', '1520', '15', 'From tradebook (NSE, 3 fills)'],
      ['2026-05-04', 'TCS', 'Short', '3500', '3480', '2', 'From tradebook (NSE, 2 fills)'],
    ]);
  });

  it('does not pair across days and reports positions left open', () => {
    const result = tradebookToRoundTrips(ZERODHA, [
      zerodhaRow('SBIN', '2026-05-04', 'buy', 10, 800, 1, '09:20:00'),
      zerodhaRow('SBIN', '2026-05-05', 'sell', 10, 810, 2, '09:20:00'),
    ]);
    expect(result.rows).toEqual([]);
    expect(result.open).toEqual([
      { date: '2026-05-04', symbol: 'SBIN', quantity: 10 },
      { date: '2026-05-05', symbol: 'SBIN', quantity: -10 },
    ]);
  });

  it('skips derivative fills and unreadable rows', () => {
    const result = tradebookToRoundTrips(ZERODHA, [
      zerodhaRow('NIFTY26MAYFUT', '2026-05-04', 'buy', 75, 24000, 1, '09:20:00', {
        exchange: 'NFO',
        segment: 'FO',
      }),
      zerodhaRow('INFY', '2026-05-04', 'hold', 10, 1500, 2, '09:20:00'),
      ['', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    expect(result.fills).toBe(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({ line: 2, symbol: 'NIFTY26MAYFUT' }),
      expect.objectContaining({ line: 3, reason: expect.stringMatching(/side/) }),
    ]);
  });

  it('reads day-first dates, -EQ suffixes and dates carrying the time', () => {
    const result = tradebookToRoundTrips(
      ['Trade Date', 'Symbol', 'Exchange', 'Buy/Sell', 'Qty', 'Trade Price'],
      [
        ['04-05-2026 10:15:00', 'RELIANCE-EQ', 'BSE', 'S', '4', '1,410.50'],
        ['04-05-2026 09:15:00', 'RELIANCE-EQ', 'BSE', 'B', '4', '1,400'],
      ],
    );
    expect(result.rows).toEqual([
      ['2026-05-04', 'RELIANCE', 'Long', '1400', '1410.5', '4', 'From tradebook (BSE, 2 fills)'],
    ]);
  });
});
