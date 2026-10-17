import { describe, expect, it } from 'vitest';
import { buildCandidates, guessMapping, parseCsv } from '../../shared/csv.js';
import {
  computeGrossPnl,
  filterByRange,
  rangeStart,
  validateTradeInput,
} from '../../shared/pnl.js';
import { toIst } from '../../shared/market.js';

describe('synthetic range, validation and short-import regression', () => {
  it('YTD starts in the IST business year', () => {
    const instant = new Date('2025-12-31T20:00:00Z');
    expect(toIst(instant).date).toBe('2026-01-01');
    expect(rangeStart('ytd', instant)).toBe('2026-01-01');
  });
  it('seven-day range uses IST midnight', () => {
    const instant = new Date('2026-10-04T20:00:00Z');
    expect(toIst(instant).date).toBe('2026-10-05');
    expect(rangeStart('7d', instant)).toBe('2026-09-29'); // IST inclusive boundary Sep 29
  });
  it('bounded recent range excludes future dates', () => {
    const future = { date: '2027-01-01' };
    expect(filterByRange([future], '7d', new Date('2026-10-05T10:00:00Z'))).toEqual([]);
  });
  it('Buy Price and Sell Price aliases correctly map a short roundtrip', () => {
    const csv = parseCsv(
      'Date,Symbol,Side,Qty,Buy Price,Sell Price\n2026-10-05,TCS,SELL,10,100,110',
    );
    const { candidates, errors } = buildCandidates(csv.rows, guessMapping(csv.headers));
    expect(errors).toEqual([]);
    const trade = candidates[0];
    expect(trade).toMatchObject({ type: 'Short', entryPrice: 110, exitPrice: 100 });
    expect(computeGrossPnl(trade)).toBe(100); // short sells 110, buys 100: profit +100
  });
  it('manual validation rejects fractional shares even when native input constraints are bypassed', () => {
    expect(
      validateTradeInput({
        date: '2026-10-05',
        symbol: 'TCS',
        entryPrice: '100',
        exitPrice: '110',
        quantity: '1.5',
      }),
    ).toEqual({ quantity: 'Quantity must be a whole number of shares.' });
  });
  it('CSV rejects negative/zero/fractional shares and impossible dates in usual values', () => {
    const csv = parseCsv(
      'Date,Symbol,Side,Qty,Entry,Exit\n2026-10-05,TCS,BUY,0,100,110\n2026-10-05,TCS,BUY,-1,100,110\n2026-10-05,TCS,BUY,1.5,100,110\n2026-02-31,TCS,BUY,1,100,110',
    );
    const { candidates, errors } = buildCandidates(csv.rows, guessMapping(csv.headers));
    expect(candidates).toEqual([]);
    expect(errors).toHaveLength(4);
  });
});
