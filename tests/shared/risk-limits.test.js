import { describe, expect, it } from 'vitest';
import { parseRiskLimits, riskStatus, toRiskLimits } from '../../shared/risk-limits.js';

describe('risk limits', () => {
  it('validates optional limits', () => {
    expect(
      parseRiskLimits({ dailyLossLimit: '2000', maxTradesPerDay: '5', monthlyProfitGoal: '' }),
    ).toEqual({
      values: { dailyLossLimit: 2000, maxTradesPerDay: 5, monthlyProfitGoal: null },
      errors: {},
    });
    const { errors } = parseRiskLimits({ dailyLossLimit: -5, maxTradesPerDay: 2.5 });
    expect(Object.keys(errors)).toEqual(['dailyLossLimit', 'maxTradesPerDay']);
    expect(toRiskLimits(null)).toEqual({
      dailyLossLimit: null,
      maxTradesPerDay: null,
      monthlyProfitGoal: null,
    });
  });

  it('blocks after the daily loss or trade count is reached', () => {
    const trades = [
      { date: '2026-10-12', pnl: -1500 },
      { date: '2026-10-12', pnl: -600 },
      { date: '2026-10-09', pnl: 5000 },
      { date: '2026-09-30', pnl: 9999 },
    ];
    const status = riskStatus(
      trades,
      toRiskLimits({ dailyLossLimit: 2000, maxTradesPerDay: 3, monthlyProfitGoal: 10000 }),
      '2026-10-12',
    );
    expect(status).toMatchObject({
      todayPnl: -2100,
      todayTrades: 2,
      monthPnl: 2900,
      dailyLossHit: true,
      maxTradesHit: false,
      lossUsed: 1.05,
      goalProgress: 0.29,
      blocked: true,
    });
    expect(status.reasons).toEqual([expect.stringContaining('Daily loss limit reached')]);
    const relaxed = riskStatus(trades, toRiskLimits({ maxTradesPerDay: 2 }), '2026-10-12');
    expect(relaxed).toMatchObject({
      dailyLossHit: false,
      maxTradesHit: true,
      lossUsed: null,
      blocked: true,
    });
    expect(riskStatus([], toRiskLimits({}), '2026-10-12').blocked).toBe(false);
  });
});
