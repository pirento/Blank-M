import { describe, expect, it } from 'vitest';
import {
  calendarMonths,
  dailyPnl,
  emotionStats,
  mistakeSummary,
  rStats,
  strategyCurves,
  tagStats,
  weekdayStats,
} from '../../shared/insights.js';

let sequence = 0;
const trade = (fields) => ({
  id: `t${(sequence += 1)}`,
  date: '2026-10-05',
  symbol: 'INFY',
  pnl: 0,
  grossPnl: 0,
  charges: 0,
  setupTags: [],
  mistakeTags: [],
  emotion: '',
  plannedRisk: null,
  strategyId: null,
  createdAt: `2026-10-05T0${sequence % 10}:00:00.000Z`,
  ...fields,
});

describe('insights', () => {
  it('sums net P&L per day and lays out a Monday-first calendar', () => {
    const trades = [
      trade({ date: '2026-10-05', pnl: 100 }),
      trade({ date: '2026-10-05', pnl: -40 }),
      trade({ date: '2026-10-06', pnl: 25.5 }),
    ];
    expect(dailyPnl(trades)['2026-10-05']).toEqual({ pnl: 60, count: 2 });
    const [october] = calendarMonths(trades, 1, new Date(Date.UTC(2026, 9, 20)));
    expect(october.key).toBe('2026-10');
    expect(october.netPnl).toBe(85.5);
    // 1 October 2026 is a Thursday: three padding cells before it.
    expect(october.weeks[0].slice(0, 3)).toEqual([null, null, null]);
    expect(october.weeks[0][3].date).toBe('2026-10-01');
    expect(october.weeks.flat().find((cell) => cell?.date === '2026-10-05')).toMatchObject({
      pnl: 60,
      count: 2,
    });
  });

  it('groups by weekday, tag and emotion with the costliest first', () => {
    const trades = [
      trade({ date: '2026-10-05', pnl: -300, mistakeTags: ['Moved stop'], emotion: 'fomo' }),
      trade({ date: '2026-10-06', pnl: -100, mistakeTags: ['moved stop', 'Oversized'] }),
      trade({ date: '2026-10-06', pnl: 200, setupTags: ['Breakout'], emotion: 'calm' }),
    ];
    const weekdays = weekdayStats(trades);
    expect(weekdays[0]).toMatchObject({ label: 'Mon', count: 1, netPnl: -300 });
    expect(weekdays[1]).toMatchObject({ label: 'Tue', count: 2, netPnl: 100, winRate: 50 });
    const mistakes = tagStats(trades, 'mistakeTags');
    expect(mistakes[0]).toMatchObject({ tag: 'Moved stop', count: 2, netPnl: -400 });
    expect(mistakes[1]).toMatchObject({ tag: 'Oversized', netPnl: -100 });
    expect(emotionStats(trades).map((row) => row.emotion)).toEqual(['fomo', 'calm']);
    expect(mistakeSummary(trades)).toMatchObject({
      withMistakes: { count: 2, netPnl: -400 },
      clean: { count: 1, netPnl: 200 },
    });
  });

  it('computes R-multiples only for trades with a planned risk', () => {
    const stats = rStats([
      trade({ pnl: 500, plannedRisk: 250 }),
      trade({ pnl: -250, plannedRisk: 250 }),
      trade({ pnl: 100 }),
    ]);
    expect(stats).toMatchObject({ count: 2, missing: 1, totalR: 1, averageR: 0.5, bestR: 2 });
    expect(stats.buckets.find((bucket) => bucket.label === '≥ 2R').count).toBe(1);
    expect(stats.buckets.find((bucket) => bucket.label === '-2R to -1R').count).toBe(1);
  });

  it('builds cumulative curves per strategy', () => {
    const curves = strategyCurves(
      [
        trade({ date: '2026-10-05', pnl: 100, strategyId: 's1' }),
        trade({ date: '2026-10-06', pnl: -30, strategyId: 's1' }),
        trade({ date: '2026-10-06', pnl: -50, strategyId: 'gone' }),
      ],
      [{ id: 's1', name: 'Breakout' }],
    );
    expect(curves.map((curve) => curve.name)).toEqual(['Breakout', 'No strategy']);
    expect(curves[0].points.map((point) => point.value)).toEqual([100, 70]);
  });
});
