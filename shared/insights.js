/**
 * Insights calculations for the trade journal: daily P&L calendar, weekday
 * performance, results by setup / mistake / emotion tag, R-multiples and
 * per-strategy equity curves. Pure functions over net-P&L trades, shared by
 * the browser and tests.
 */
import { sortTradesChronologically } from './pnl.js';
import { rMultiple } from './trade-tags.js';

const round2 = (value) => Math.round(value * 100) / 100;

/** Count, net P&L, win rate and average net P&L of a group of trades. */
export function groupStats(trades) {
  const net = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  return {
    count: trades.length,
    netPnl: round2(net),
    winRate: trades.length ? Math.round((wins / trades.length) * 1000) / 10 : 0,
    averagePnl: trades.length ? round2(net / trades.length) : 0,
  };
}

/** Net P&L and trade count per IST date: { 'YYYY-MM-DD': { pnl, count } }. */
export function dailyPnl(trades) {
  const days = {};
  for (const trade of trades) {
    const day = (days[trade.date] ??= { pnl: 0, count: 0 });
    day.pnl = round2(day.pnl + trade.pnl);
    day.count += 1;
  }
  return days;
}

/**
 * Calendar months for a heatmap, newest first: each month lists its weeks
 * (Monday first) of cells { date, pnl, count } or null for padding.
 */
export function calendarMonths(trades, monthCount = 3, today = new Date()) {
  const days = dailyPnl(trades);
  const months = [];
  for (let offset = 0; offset < monthCount; offset += 1) {
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1));
    const year = first.getUTCFullYear();
    const month = first.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const cells = Array((first.getUTCDay() + 6) % 7).fill(null);
    let total = 0;
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const entry = days[date];
      total += entry?.pnl ?? 0;
      cells.push({ date, pnl: entry?.pnl ?? 0, count: entry?.count ?? 0 });
    }
    while (cells.length % 7) cells.push(null);
    const weeks = [];
    for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
    months.push({
      key: `${year}-${String(month + 1).padStart(2, '0')}`,
      label: first.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      netPnl: round2(total),
      weeks,
    });
  }
  return months;
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

/** Results per trading weekday (dates are IST calendar dates). */
export function weekdayStats(trades) {
  return WEEKDAYS.map((label, index) => ({
    label,
    ...groupStats(
      trades.filter((trade) => (new Date(`${trade.date}T00:00:00Z`).getUTCDay() + 6) % 7 === index),
    ),
  }));
}

/**
 * Results per tag of `field` ('setupTags' or 'mistakeTags'), worst net P&L
 * first, so the costliest mistakes lead. A trade with two tags counts in both.
 */
export function tagStats(trades, field) {
  const groups = new Map();
  for (const trade of trades) {
    for (const tag of trade[field] ?? []) {
      const key = tag.toLowerCase();
      if (!groups.has(key)) groups.set(key, { tag, trades: [] });
      groups.get(key).trades.push(trade);
    }
  }
  return [...groups.values()]
    .map(({ tag, trades: tagged }) => ({ tag, ...groupStats(tagged) }))
    .sort((left, right) => left.netPnl - right.netPnl || left.tag.localeCompare(right.tag));
}

/** Results per recorded emotion (trades without one are left out). */
export function emotionStats(trades) {
  const groups = new Map();
  for (const trade of trades) {
    if (!trade.emotion) continue;
    if (!groups.has(trade.emotion)) groups.set(trade.emotion, []);
    groups.get(trade.emotion).push(trade);
  }
  return [...groups.entries()]
    .map(([emotion, grouped]) => ({ emotion, ...groupStats(grouped) }))
    .sort((left, right) => left.netPnl - right.netPnl);
}

/** What trades tagged with any mistake cost compared with clean trades. */
export function mistakeSummary(trades) {
  const withMistakes = trades.filter((trade) => (trade.mistakeTags ?? []).length > 0);
  const clean = trades.filter((trade) => (trade.mistakeTags ?? []).length === 0);
  return { withMistakes: groupStats(withMistakes), clean: groupStats(clean) };
}

export const R_BUCKETS = [
  { label: '≤ -2R', test: (r) => r <= -2 },
  { label: '-2R to -1R', test: (r) => r > -2 && r <= -1 },
  { label: '-1R to 0', test: (r) => r > -1 && r < 0 },
  { label: '0 to 1R', test: (r) => r >= 0 && r < 1 },
  { label: '1R to 2R', test: (r) => r >= 1 && r < 2 },
  { label: '≥ 2R', test: (r) => r >= 2 },
];

/** R-multiple statistics over trades that recorded a planned risk. */
export function rStats(trades) {
  const values = trades.map(rMultiple).filter((value) => value !== null);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    missing: trades.length - values.length,
    totalR: round2(total),
    averageR: values.length ? round2(total / values.length) : 0,
    bestR: values.length ? Math.max(...values) : null,
    worstR: values.length ? Math.min(...values) : null,
    buckets: R_BUCKETS.map((bucket) => ({
      label: bucket.label,
      count: values.filter(bucket.test).length,
    })),
  };
}

/**
 * Cumulative net P&L per strategy in trade order (unlinked trades are grouped
 * as "No strategy"). Each curve: { id, name, points: [{ date, value }], stats }.
 */
export function strategyCurves(trades, strategies) {
  const names = new Map(strategies.map((strategy) => [strategy.id, strategy.name]));
  const groups = new Map();
  for (const trade of sortTradesChronologically(trades)) {
    const id = trade.strategyId && names.has(trade.strategyId) ? trade.strategyId : null;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(trade);
  }
  return [...groups.entries()]
    .map(([id, grouped]) => {
      let running = 0;
      return {
        id,
        name: id ? names.get(id) : 'No strategy',
        points: grouped.map((trade) => ({
          date: trade.date,
          value: round2((running += trade.pnl)),
        })),
        stats: groupStats(grouped),
      };
    })
    .sort((left, right) => right.stats.netPnl - left.stats.netPnl);
}
