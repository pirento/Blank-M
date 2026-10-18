/**
 * "Where you make and lose money": net P&L per weekday × entry-time bucket,
 * and the best and worst setups, mistakes, emotions and symbols. Pure
 * functions over net-P&L trades, shared by the Insights page and tests.
 */
import { WEEKDAYS, groupStats } from './insights.js';
import { rMultiple } from './trade-tags.js';

/** Entry-time columns (IST). `until` is exclusive; the last bucket takes the rest of the day. */
export const TIME_BUCKETS = [
  { label: '09:15–10:00', until: '10:00' },
  { label: '10:00–11:00', until: '11:00' },
  { label: '11:00–12:00', until: '12:00' },
  { label: '12:00–13:00', until: '13:00' },
  { label: '13:00–14:00', until: '14:00' },
  { label: '14:00–15:30', until: null },
];
export const UNKNOWN_TIME = 'Unknown time';

/** Groups with fewer trades than this are left out of the rankings (too few to mean much). */
export const MIN_GROUP_TRADES = 3;

const round2 = (value) => Math.round(value * 100) / 100;

/** Column index for an 'HH:MM' entry time; the last index is "Unknown time". */
export function timeBucket(entryTime) {
  if (!/^\d{2}:\d{2}$/.test(entryTime ?? '')) return TIME_BUCKETS.length;
  // 'HH:MM' strings compare in time order; pre-open entries count in the first bucket.
  const index = TIME_BUCKETS.findIndex((bucket) => bucket.until && entryTime < bucket.until);
  return index === -1 ? TIME_BUCKETS.length - 1 : index;
}

/**
 * Weekday rows × time-bucket columns of { pnl, count }. Weekend sessions
 * (e.g. Muhurat trading) have no row and are only counted in `weekend`.
 */
export function edgeGrid(trades) {
  const columns = [...TIME_BUCKETS.map((bucket) => bucket.label), UNKNOWN_TIME];
  const rows = WEEKDAYS.map((label) => ({
    label,
    cells: columns.map(() => ({ pnl: 0, count: 0 })),
  }));
  let weekend = 0;
  for (const trade of trades) {
    const day = (new Date(`${trade.date}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (day > 4) {
      weekend += 1;
      continue;
    }
    const cell = rows[day].cells[timeBucket(trade.entryTime)];
    cell.pnl = round2(cell.pnl + trade.pnl);
    cell.count += 1;
  }
  const largest = Math.max(
    0,
    ...rows.flatMap((row) => row.cells.map((cell) => Math.abs(cell.pnl))),
  );
  return { columns, rows, largest, weekend };
}

/**
 * Best (net P&L above zero, highest first) and worst (below zero, lowest
 * first) groups among those with at least `minTrades` trades. `keysOf(trade)`
 * lists the group names a trade belongs to; names are matched ignoring case
 * and the first spelling is shown. `averageR` is null when no trade in the
 * group has a planned risk or stop.
 */
export function rankGroups(trades, keysOf, { minTrades = MIN_GROUP_TRADES, limit = 5 } = {}) {
  const groups = new Map();
  for (const trade of trades) {
    for (const name of keysOf(trade)) {
      if (!name) continue;
      const key = name.toLowerCase();
      if (!groups.has(key)) groups.set(key, { name, trades: [] });
      groups.get(key).trades.push(trade);
    }
  }
  const qualified = [...groups.values()]
    .filter((group) => group.trades.length >= minTrades)
    .map(({ name, trades: grouped }) => {
      const rs = grouped.map(rMultiple).filter((value) => value !== null);
      return {
        name,
        ...groupStats(grouped),
        averageR: rs.length ? round2(rs.reduce((sum, value) => sum + value, 0) / rs.length) : null,
      };
    });
  const ranked = (keep, direction) =>
    qualified
      .filter(keep)
      .sort(
        (left, right) =>
          direction * (right.netPnl - left.netPnl) || left.name.localeCompare(right.name),
      )
      .slice(0, limit);
  return {
    groups: groups.size,
    qualified: qualified.length,
    best: ranked((group) => group.netPnl > 0, 1),
    worst: ranked((group) => group.netPnl < 0, -1),
  };
}

/** Rankings for the four dimensions the Insights page shows. */
export function edgeRankings(trades, options) {
  return {
    setup: rankGroups(trades, (trade) => trade.setupTags ?? [], options),
    mistake: rankGroups(trades, (trade) => trade.mistakeTags ?? [], options),
    emotion: rankGroups(trades, (trade) => [trade.emotion], options),
    symbol: rankGroups(trades, (trade) => [trade.symbol], options),
  };
}
