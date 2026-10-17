import { describe, expect, it } from 'vitest';
import { financialYearOf, financialYears, taxCsv, taxReport } from '../../shared/tax-report.js';

const trade = (fields) => ({
  date: '2026-05-04',
  symbol: 'INFY',
  type: 'Long',
  entryPrice: 100,
  exitPrice: 110,
  quantity: 10,
  grossPnl: 100,
  charges: 5,
  pnl: 95,
  segment: 'EQ',
  ...fields,
});

describe('tax report', () => {
  it('maps dates to Indian financial years', () => {
    expect(financialYearOf('2026-03-31')).toBe('2025-26');
    expect(financialYearOf('2026-04-01')).toBe('2026-27');
    expect(financialYears([trade({}), trade({ date: '2026-01-10' })])).toEqual([
      '2026-27',
      '2025-26',
    ]);
  });

  it('splits speculative and F&O income with absolute-P&L turnover', () => {
    const trades = [
      trade({}),
      trade({ date: '2026-07-01', grossPnl: -40, charges: 2, pnl: -42 }),
      trade({ date: '2026-11-02', segment: 'OPT', grossPnl: 300, charges: 50, pnl: 250 }),
      trade({
        date: '2026-12-01',
        type: 'Short',
        segment: 'FUT',
        entryPrice: 200,
        exitPrice: 190,
        grossPnl: 100,
        charges: 10,
        pnl: 90,
      }),
      trade({ date: '2027-04-01', grossPnl: 1000, pnl: 1000 }), // next year
    ];
    const report = taxReport(trades, '2026-27');
    expect(report.categories.speculative).toMatchObject({
      trades: 2,
      grossPnl: 60,
      charges: 7,
      netPnl: 53,
      turnover: 140,
    });
    expect(report.categories.nonSpeculative).toMatchObject({
      trades: 2,
      netPnl: 340,
      turnover: 400,
    });
    // A short buys at exit and sells at entry.
    expect(report.categories.nonSpeculative.buyValue).toBe(1000 + 1900);
    expect(report.total.netPnl).toBe(393);
    expect(report.advanceTax.map((point) => point.cumulativeNetPnl)).toEqual([95, 53, 393, 393]);
    expect(report.months[0]).toMatchObject({ key: '2026-04', trades: 0 });
    expect(report.months[11].key).toBe('2027-03');
  });

  it('exports one CSV row per trade of the year', () => {
    const csv = taxCsv([trade({ symbol: '=HACK' }), trade({ date: '2025-12-01' })], '2026-27');
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("'=HACK");
    expect(lines[1]).toContain('Speculative');
  });
});
