import { describe, expect, it } from 'vitest';
import {
  bestAndWorst,
  buildDrawdownCurve,
  filterByRange,
  maxDrawdown,
  pnlBySymbol,
  pnlByWeekday,
  pnlDistribution,
  rangeStart,
} from '../../shared/pnl.js';

function makeTrade(overrides = {}) {
  return {
    id: 'id',
    date: '2026-01-05',
    symbol: 'RELIANCE',
    type: 'Long',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 10,
    grossPnl: 100,
    charges: 0,
    pnl: 100,
    notes: '',
    strategyId: null,
    createdAt: '2026-01-05T10:00:00.000Z',
    ...overrides,
  };
}

describe('rangeStart', () => {
  const today = new Date(2026, 5, 15); // 15 June 2026, local time.

  it('counts inclusively, so 7 days is today plus the six before it', () => {
    expect(rangeStart('7d', today)).toBe('2026-06-09');
  });

  it('handles a window that crosses a month boundary', () => {
    expect(rangeStart('30d', today)).toBe('2026-05-17');
    expect(rangeStart('90d', today)).toBe('2026-03-18');
  });

  it('starts the year on 1 January for year to date', () => {
    expect(rangeStart('ytd', today)).toBe('2026-01-01');
  });

  it('has no start at all for all time', () => {
    expect(rangeStart('all', today)).toBeNull();
  });
});

describe('filterByRange', () => {
  const today = new Date(2026, 5, 15);
  const trades = [
    makeTrade({ id: 'old', date: '2025-12-31' }),
    makeTrade({ id: 'january', date: '2026-01-02' }),
    makeTrade({ id: 'recent', date: '2026-06-12' }),
    makeTrade({ id: 'today', date: '2026-06-15' }),
  ];

  it('keeps only trades on or after the start date', () => {
    expect(filterByRange(trades, '7d', today).map((t) => t.id)).toEqual(['recent', 'today']);
  });

  it('includes a trade dated exactly on the boundary', () => {
    expect(filterByRange(trades, 'ytd', today).map((t) => t.id)).toEqual([
      'january',
      'recent',
      'today',
    ]);
  });

  it('returns everything for all time', () => {
    expect(filterByRange(trades, 'all', today)).toHaveLength(4);
  });
});

describe('buildDrawdownCurve', () => {
  it('is flat at zero while the account only climbs', () => {
    const trades = [makeTrade({ id: 'a', pnl: 100 }), makeTrade({ id: 'b', pnl: 50 })];
    expect(buildDrawdownCurve(1000, trades).map((p) => p.drawdown)).toEqual([0, 0, 0]);
  });

  it('measures from the running peak, not from the opening balance', () => {
    const trades = [
      makeTrade({ id: 'a', date: '2026-01-01', pnl: 500 }),
      makeTrade({ id: 'b', date: '2026-01-02', pnl: -200 }),
      makeTrade({ id: 'c', date: '2026-01-03', pnl: -100 }),
    ];
    // Balance: 1000 → 1500 → 1300 → 1200, peak stays 1500.
    expect(buildDrawdownCurve(1000, trades).map((p) => p.drawdown)).toEqual([0, 0, -200, -300]);
  });

  it('resets to zero once a new high is made', () => {
    const trades = [
      makeTrade({ id: 'a', date: '2026-01-01', pnl: -100 }),
      makeTrade({ id: 'b', date: '2026-01-02', pnl: 400 }),
    ];
    expect(buildDrawdownCurve(1000, trades).map((p) => p.drawdown)).toEqual([0, -100, 0]);
  });
});

describe('maxDrawdown', () => {
  it('is zero when the account never dips below its peak', () => {
    expect(maxDrawdown(1000, [makeTrade({ pnl: 100 })])).toBe(0);
  });

  it('reports the deepest fall as a positive number', () => {
    const trades = [
      makeTrade({ id: 'a', date: '2026-01-01', pnl: 500 }),
      makeTrade({ id: 'b', date: '2026-01-02', pnl: -700 }),
      makeTrade({ id: 'c', date: '2026-01-03', pnl: 900 }),
    ];
    expect(maxDrawdown(1000, trades)).toBe(700);
  });

  it('is zero for an account with no trades', () => {
    expect(maxDrawdown(1000, [])).toBe(0);
  });
});

describe('pnlBySymbol', () => {
  it('sums each symbol and orders the winners first', () => {
    const trades = [
      makeTrade({ id: 'a', symbol: 'TCS', pnl: -300 }),
      makeTrade({ id: 'b', symbol: 'RELIANCE', pnl: 200 }),
      makeTrade({ id: 'c', symbol: 'RELIANCE', pnl: 100 }),
    ];
    expect(pnlBySymbol(trades)).toEqual([
      { key: 'RELIANCE', netPnl: 300, trades: 2, wins: 2 },
      { key: 'TCS', netPnl: -300, trades: 1, wins: 0 },
    ]);
  });

  it('is empty for no trades', () => {
    expect(pnlBySymbol([])).toEqual([]);
  });
});

describe('pnlByWeekday', () => {
  it('always returns Monday to Friday in week order', () => {
    expect(pnlByWeekday([]).map((g) => g.key)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
    ]);
  });

  it('places a trade on the weekday of its date', () => {
    // 2026-06-15 is a Monday; 2026-06-17 a Wednesday.
    const trades = [
      makeTrade({ id: 'a', date: '2026-06-15', pnl: 400 }),
      makeTrade({ id: 'b', date: '2026-06-17', pnl: -100 }),
    ];
    const result = pnlByWeekday(trades);
    expect(result[0]).toEqual({ key: 'Monday', netPnl: 400, trades: 1, wins: 1 });
    expect(result[2]).toEqual({ key: 'Wednesday', netPnl: -100, trades: 1, wins: 0 });
    expect(result[1]?.trades).toBe(0);
  });
});

describe('pnlDistribution', () => {
  it('orders buckets from the largest loss to the largest win', () => {
    expect(pnlDistribution([]).map((b) => b.label)).toEqual([
      'Loss > ₹5k',
      'Loss ₹2k–5k',
      'Loss ₹500–2k',
      'Loss < ₹500',
      'Win < ₹500',
      'Win ₹500–2k',
      'Win ₹2k–5k',
      'Win > ₹5k',
    ]);
  });

  it('files each trade by the magnitude of its net P&L', () => {
    const trades = [
      makeTrade({ id: 'a', pnl: 100 }),
      makeTrade({ id: 'b', pnl: 1500 }),
      makeTrade({ id: 'c', pnl: 9000 }),
      makeTrade({ id: 'd', pnl: -300 }),
      makeTrade({ id: 'e', pnl: -6000 }),
    ];
    const counts = Object.fromEntries(pnlDistribution(trades).map((b) => [b.label, b.count]));
    expect(counts['Win < ₹500']).toBe(1);
    expect(counts['Win ₹500–2k']).toBe(1);
    expect(counts['Win > ₹5k']).toBe(1);
    expect(counts['Loss < ₹500']).toBe(1);
    expect(counts['Loss > ₹5k']).toBe(1);
  });

  it('ignores scratch trades, which belong to neither side', () => {
    const total = pnlDistribution([makeTrade({ pnl: 0 })]).reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(0);
  });

  it('puts a trade exactly on an edge into the higher bucket', () => {
    const counts = Object.fromEntries(
      pnlDistribution([makeTrade({ pnl: 500 })]).map((b) => [b.label, b.count]),
    );
    expect(counts['Win ₹500–2k']).toBe(1);
    expect(counts['Win < ₹500']).toBe(0);
  });
});

describe('bestAndWorst', () => {
  it('finds the extremes by net P&L', () => {
    const trades = [
      makeTrade({ id: 'a', pnl: 100 }),
      makeTrade({ id: 'b', pnl: -500 }),
      makeTrade({ id: 'c', pnl: 900 }),
    ];
    expect(bestAndWorst(trades).best?.id).toBe('c');
    expect(bestAndWorst(trades).worst?.id).toBe('b');
  });

  it('returns the same trade for both when there is only one', () => {
    const only = makeTrade({ id: 'solo', pnl: -20 });
    expect(bestAndWorst([only])).toEqual({ best: only, worst: only });
  });

  it('returns nulls for an empty book', () => {
    expect(bestAndWorst([])).toEqual({ best: null, worst: null });
  });
});
