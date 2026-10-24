/**
 * Personal risk limits: a daily loss limit, a maximum number of trades per
 * day and a monthly profit goal. Each is optional (null = off). The status is
 * computed from journal trades for the IST trading day and month; when the
 * daily loss or trade-count limit is reached, live orders are refused.
 */

const MAX_AMOUNT = 1e12;

function optionalAmount(value, label, errors, key) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= MAX_AMOUNT) {
    errors[key] = `${label} must be a positive amount, or empty to turn it off.`;
    return null;
  }
  return Math.round(number * 100) / 100;
}

/** Validates input; returns { values, errors } (errors maps field → message). */
export function parseRiskLimits(input = {}) {
  const errors = {};
  const values = {
    dailyLossLimit: optionalAmount(
      input.dailyLossLimit,
      'Daily loss limit',
      errors,
      'dailyLossLimit',
    ),
    maxTradesPerDay: null,
    monthlyProfitGoal: optionalAmount(
      input.monthlyProfitGoal,
      'Monthly goal',
      errors,
      'monthlyProfitGoal',
    ),
  };
  const trades = input.maxTradesPerDay;
  if (trades !== null && trades !== undefined && trades !== '') {
    const number = Number(trades);
    if (!Number.isInteger(number) || number < 1 || number > 1000) {
      errors.maxTradesPerDay = 'Trades per day must be a whole number from 1 to 1000, or empty.';
    } else {
      values.maxTradesPerDay = number;
    }
  }
  return { values, errors };
}

/** Stored settings → limits with every field present. */
export function toRiskLimits(stored) {
  const { values } = parseRiskLimits(stored && typeof stored === 'object' ? stored : {});
  return values;
}

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Where the member stands today and this month.
 * @param {{ date: string, pnl: number }[]} trades journal trades
 * @param {object} limits from toRiskLimits
 * @param {string} today IST date YYYY-MM-DD
 */
export function riskStatus(trades, limits, today) {
  const month = today.slice(0, 7);
  let todayPnl = 0;
  let todayTrades = 0;
  let monthPnl = 0;
  for (const trade of trades) {
    const pnl = Number(trade.pnl) || 0;
    if (trade.date === today) {
      todayPnl += pnl;
      todayTrades += 1;
    }
    if (String(trade.date).slice(0, 7) === month) monthPnl += pnl;
  }
  const reasons = [];
  const dailyLossHit = limits.dailyLossLimit !== null && todayPnl <= -limits.dailyLossLimit;
  if (dailyLossHit) {
    reasons.push(
      `Daily loss limit reached: today is ₹${round2(todayPnl)} against a limit of −₹${limits.dailyLossLimit}.`,
    );
  }
  const maxTradesHit = limits.maxTradesPerDay !== null && todayTrades >= limits.maxTradesPerDay;
  if (maxTradesHit) {
    reasons.push(`Trade limit reached: ${todayTrades} of ${limits.maxTradesPerDay} trades today.`);
  }
  return {
    today,
    todayPnl: round2(todayPnl),
    todayTrades,
    monthPnl: round2(monthPnl),
    dailyLossHit,
    maxTradesHit,
    /** Share of the daily loss limit used (0–1+), or null when there is no limit. */
    lossUsed:
      limits.dailyLossLimit !== null
        ? round2(Math.max(0, -todayPnl) / limits.dailyLossLimit)
        : null,
    goalProgress:
      limits.monthlyProfitGoal !== null ? round2(monthPnl / limits.monthlyProfitGoal) : null,
    blocked: dailyLossHit || maxTradesHit,
    reasons,
  };
}
