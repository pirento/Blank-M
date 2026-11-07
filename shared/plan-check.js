/**
 * The facts behind a pre-trade check of a saved order plan, worked out from the member's own journal
 * and risk limits. Everything here is arithmetic, so the numbers never come from an AI; the AI
 * review (services/ai/plan-check.js) only reads them.
 */
import { riskStatus } from './risk-limits.js';

const round2 = (value) => Math.round(value * 100) / 100;
const rupees = (value) => `${value < 0 ? '−' : ''}₹${Math.abs(value)}`;

/** Trades, win rate (%) and net P&L of a set of journal trades; win rate null when there are none. */
function record(trades) {
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  return {
    trades: trades.length,
    winRate: trades.length ? Math.round((wins / trades.length) * 100) : null,
    netPnl: round2(trades.reduce((sum, trade) => sum + trade.pnl, 0)),
  };
}

/** Losing trades in a row, counted back from the most recent trade. */
function lossStreak(trades) {
  const latestFirst = [...trades].sort(
    (a, b) =>
      b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)),
  );
  let streak = 0;
  for (const trade of latestFirst) {
    if (trade.pnl >= 0) break;
    streak += 1;
  }
  return streak;
}

/**
 * Facts and warnings for one saved plan.
 * @param {object} plan a synced plan record (symbol, direction, inputs, estimate, strategySnapshot)
 * @param {{ date: string, symbol: string, type: string, pnl: number, strategyId?: string|null, createdAt?: string }[]} trades
 * @param {object} limits from toRiskLimits
 * @param {string} today IST date YYYY-MM-DD
 * @returns {{ facts: object, warnings: { level: 'stop'|'caution', text: string }[] }}
 */
export function planCheckFacts(plan, trades, limits, today) {
  const risk = riskStatus(trades, limits, today);
  const plannedLoss = round2(plan.estimate.stopLossIncludingFeesPaise / 100);
  const strategyId = plan.strategySnapshot?.id ?? null;
  const facts = {
    symbol: record(trades.filter((trade) => trade.symbol === plan.symbol)),
    direction: record(trades.filter((trade) => trade.type === plan.direction)),
    strategy: strategyId ? record(trades.filter((trade) => trade.strategyId === strategyId)) : null,
    overall: record(trades),
    lossStreak: lossStreak(trades),
    today: {
      pnl: risk.todayPnl,
      trades: risk.todayTrades,
      dailyLossLimit: limits.dailyLossLimit,
      maxTradesPerDay: limits.maxTradesPerDay,
    },
    plannedLoss,
    riskPercent: Number(plan.inputs.riskPercent),
    rewardRisk: plan.estimate.netRewardRiskRatio,
  };

  const warnings = [];
  const stop = (text) => warnings.push({ level: 'stop', text });
  const caution = (text) => warnings.push({ level: 'caution', text });
  for (const reason of risk.reasons) stop(reason);
  if (limits.dailyLossLimit !== null && !risk.dailyLossHit) {
    const room = round2(limits.dailyLossLimit + Math.min(0, risk.todayPnl));
    if (plannedLoss > room) {
      stop(
        `If this trade hits its stop (−₹${plannedLoss}), today's loss passes your daily limit (₹${room} left).`,
      );
    }
  }
  if (plan.estimate.exceedsRiskBudget) caution('The loss at the stop is above your risk budget.');
  if (plan.estimate.exceedsCapital) caution('The position needs more capital than you set aside.');
  if (facts.lossStreak >= 3) {
    caution(`${facts.lossStreak} losing trades in a row. Take a break before the next one.`);
  }
  if (facts.riskPercent > 2) caution(`${facts.riskPercent}% of the account is at risk (above 2%).`);
  if (facts.rewardRisk === null) caution('The plan has no target, so reward : risk is unknown.');
  else if (facts.rewardRisk < 1) {
    caution(`After costs the target pays ${round2(facts.rewardRisk)}× the risk (below 1).`);
  }
  if (facts.symbol.trades >= 5 && facts.symbol.winRate < 40) {
    caution(
      `Your ${plan.symbol} trades win ${facts.symbol.winRate}% of the time (${facts.symbol.trades} trades, ${rupees(facts.symbol.netPnl)}).`,
    );
  }
  if (facts.strategy && facts.strategy.trades >= 5 && facts.strategy.netPnl < 0) {
    caution(
      `This strategy is down ₹${Math.abs(facts.strategy.netPnl)} over ${facts.strategy.trades} trades.`,
    );
  }
  return { facts, warnings };
}
