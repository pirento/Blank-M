import { describe, expect, it } from 'vitest';
import { planCheckFacts } from '../../shared/plan-check.js';
import { toRiskLimits } from '../../shared/risk-limits.js';

const TODAY = '2026-11-09';
const plan = (estimate = {}) => ({
  symbol: 'TCS',
  direction: 'Long',
  inputs: { riskPercent: '1' },
  estimate: {
    stopLossIncludingFeesPaise: 150_000,
    netRewardRiskRatio: 2,
    exceedsRiskBudget: false,
    exceedsCapital: false,
    ...estimate,
  },
  strategySnapshot: { id: 'breakout', name: 'Breakout' },
});
const trade = (date, symbol, pnl, extra = {}) => ({
  date,
  symbol,
  type: 'Long',
  pnl,
  strategyId: null,
  createdAt: `${date}T10:00:00.000Z`,
  ...extra,
});

describe('plan check facts', () => {
  it('reports the record for the symbol, direction and strategy, and no warning when all is well', () => {
    const trades = [
      trade('2026-11-02', 'TCS', 500, { strategyId: 'breakout' }),
      trade('2026-11-03', 'TCS', -200, { strategyId: 'breakout' }),
      trade('2026-11-04', 'INFY', 300),
    ];
    const { facts, warnings } = planCheckFacts(plan(), trades, toRiskLimits({}), TODAY);
    expect(facts.symbol).toEqual({ trades: 2, winRate: 50, netPnl: 300 });
    expect(facts.strategy).toEqual({ trades: 2, winRate: 50, netPnl: 300 });
    expect(facts.overall).toEqual({ trades: 3, winRate: 67, netPnl: 600 });
    expect(facts.plannedLoss).toBe(1500);
    expect(warnings).toEqual([]);
  });

  it('stops a plan whose stop would pass the daily loss limit', () => {
    const trades = [trade(TODAY, 'INFY', -2000)];
    const limits = toRiskLimits({ dailyLossLimit: 3000 });
    const { warnings } = planCheckFacts(plan(), trades, limits, TODAY);
    // ₹1,000 of room is left and the stop would lose ₹1,500.
    expect(warnings).toEqual([
      {
        level: 'stop',
        text: "If this trade hits its stop (−₹1500), today's loss passes your daily limit (₹1000 left).",
      },
    ]);
    // Once the limit is reached, the limit itself is the warning.
    const hit = planCheckFacts(plan(), [trade(TODAY, 'INFY', -3000)], limits, TODAY);
    expect(hit.warnings).toHaveLength(1);
    expect(hit.warnings[0]).toMatchObject({ level: 'stop' });
    expect(hit.warnings[0].text).toMatch(/Daily loss limit reached/);
  });

  it('cautions on a losing streak, a weak symbol record, no target and a thin reward', () => {
    const losers = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map(
      (date) => trade(date, 'TCS', -100),
    );
    const noTarget = planCheckFacts(
      plan({ netRewardRiskRatio: null }),
      losers,
      toRiskLimits({}),
      TODAY,
    );
    expect(noTarget.facts.lossStreak).toBe(5);
    expect(noTarget.warnings.map((warning) => warning.text)).toEqual([
      '5 losing trades in a row. Take a break before the next one.',
      'The plan has no target, so reward : risk is unknown.',
      'Your TCS trades win 0% of the time (5 trades, −₹500).',
    ]);
    const thin = planCheckFacts(plan({ netRewardRiskRatio: 0.6 }), [], toRiskLimits({}), TODAY);
    expect(thin.warnings).toEqual([
      { level: 'caution', text: 'After costs the target pays 0.6× the risk (below 1).' },
    ]);
  });
});
