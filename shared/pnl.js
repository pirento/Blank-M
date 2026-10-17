/**
 * The single source of truth for what a trade earned.
 *
 * Every P&L figure in the app — dashboard, journal, reports, backtest — comes
 * through here, so gross and net can never drift apart between two screens.
 */
import { toIst } from './market.js';
import { isBusinessDate } from './business-dates.js';
import { DEFAULT_CHARGES } from './types.js';

const ZERO_BREAKDOWN = {
  brokerage: 0,
  stt: 0,
  exchangeTxn: 0,
  sebi: 0,
  gst: 0,
  stampDuty: 0,
  total: 0,
};

/** Existing display rounding for aggregates of already settled trade values. */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Number's canonical decimal string preserves accepted fills, including scientific
 * notation. Finite number inputs bound the exponent (and hence BigInt allocation);
 * no arbitrary user string reaches this arithmetic.
 */
function decimal(value) {
  if (!Number.isFinite(value)) return null;
  const [mantissa = '0', exponent = '0'] = String(value).split('e');
  const fractionLength = mantissa.split('.')[1]?.length ?? 0;
  const scale = fractionLength - Number(exponent);
  const units = BigInt(mantissa.replace('.', ''));
  return {
    units: scale < 0 ? units * 10n ** BigInt(-scale) : units,
    scale: Math.max(0, scale),
  };
}

function add(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    units:
      left.units * 10n ** BigInt(scale - left.scale) +
      right.units * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function subtract(left, right) {
  return add(left, { ...right, units: -right.units });
}

function multiply(left, right) {
  return { units: left.units * right.units, scale: left.scale + right.scale };
}

function percentOf(value, percent) {
  const product = multiply(value, percent);
  return { units: product.units, scale: product.scale + 2 };
}

function capped(value, maximum) {
  return subtract(value, maximum).units > 0n ? maximum : value;
}

/** Settle exact decimal rupees to paise, with half ties away from zero for both signs. */
function settle(value) {
  const divisor = 10n ** BigInt(value.scale);
  const absolute = (value.units < 0n ? -value.units : value.units) * 100n;
  const magnitude = absolute / divisor + ((absolute % divisor) * 2n >= divisor ? 1n : 0n);
  const paise = value.units < 0n ? -magnitude : magnitude;
  // Parse after scaling, avoiding an intermediate Number(paise) overflow.
  return Number(`${paise}e-2`);
}

/** Orders on one side of a trade (1 when unknown). */
export function orderCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 1000 ? count : 1;
}

/**
 * Round-trip charges in ₹ from percentage rates: brokerage capped per order, STT on the sell leg,
 * exchange and SEBI fees on turnover, GST on brokerage + fees, stamp duty on the buy leg.
 * Computed exactly and settled to paise; all zero when disabled, all NaN for invalid input.
 */
export function computeCharges(input, config = DEFAULT_CHARGES) {
  if (!config.enabled) return { ...ZERO_BREAKDOWN };

  const entry = decimal(input.entryPrice);
  const exit = decimal(input.exitPrice);
  const quantity = decimal(input.quantity);
  const brokeragePercent = decimal(config.brokeragePercent);
  const brokerageMax = decimal(config.brokerageMaxPerOrder);
  const sttPercent = decimal(config.sttPercent);
  const exchangePercent = decimal(config.exchangeTxnPercent);
  const sebiPercent = decimal(config.sebiPercent);
  const gstPercent = decimal(config.gstPercent);
  const stampPercent = decimal(config.stampDutyPercent);
  if (
    !entry ||
    !exit ||
    !quantity ||
    !brokeragePercent ||
    !brokerageMax ||
    !sttPercent ||
    !exchangePercent ||
    !sebiPercent ||
    !gstPercent ||
    !stampPercent
  ) {
    // Validation belongs at the input boundary. Do not disguise invalid economics
    // as a successful zero-fee calculation if an unchecked caller reaches here.
    return {
      brokerage: NaN,
      stt: NaN,
      exchangeTxn: NaN,
      sebi: NaN,
      gst: NaN,
      stampDuty: NaN,
      total: NaN,
    };
  }

  // A long buys at entry and sells at exit; a short does the reverse. Charges
  // attach to the buy and sell legs, not to the order they happened in.
  const buyValue = multiply(input.type === 'Long' ? entry : exit, quantity);
  const sellValue = multiply(input.type === 'Long' ? exit : entry, quantity);
  const turnover = add(buyValue, sellValue);

  // The brokerage cap applies per order: a position built from three entry
  // orders can pay up to three caps on that side. Exact when each order is
  // either above or below the cap, which is the usual case.
  const entryOrders = orderCount(input.entryOrders);
  const exitOrders = orderCount(input.exitOrders);
  const buyOrders = input.type === 'Long' ? entryOrders : exitOrders;
  const sellOrders = input.type === 'Long' ? exitOrders : entryOrders;
  const brokerage = add(
    capped(percentOf(buyValue, brokeragePercent), multiply(brokerageMax, decimal(buyOrders))),
    capped(percentOf(sellValue, brokeragePercent), multiply(brokerageMax, decimal(sellOrders))),
  );
  const stt = percentOf(sellValue, sttPercent);
  const exchangeTxn = percentOf(turnover, exchangePercent);
  const sebi = percentOf(turnover, sebiPercent);
  const gst = percentOf(add(add(brokerage, exchangeTxn), sebi), gstPercent);
  const stampDuty = percentOf(buyValue, stampPercent);

  // GST and the total use exact, unrounded components; rounding each component
  // before summing would charge a different amount for sub-paise fees.
  const total = [brokerage, stt, exchangeTxn, sebi, gst, stampDuty].reduce(add);

  return {
    brokerage: settle(brokerage),
    stt: settle(stt),
    exchangeTxn: settle(exchangeTxn),
    sebi: settle(sebi),
    gst: settle(gst),
    stampDuty: settle(stampDuty),
    total: settle(total),
  };
}

/**
 * Gross P&L in ₹: (exit − entry) × quantity for a long, reversed for a short, settled to paise.
 * Returns NaN for invalid input.
 */
export function computeGrossPnl(input) {
  const entry = decimal(input.entryPrice);
  const exit = decimal(input.exitPrice);
  const quantity = decimal(input.quantity);
  if (!entry || !exit || !quantity) return NaN;
  const exitValue = legsExitValue(input.exitLegs, input.quantity);
  if (exitValue) {
    const entryValue = multiply(entry, quantity);
    return settle(
      input.type === 'Long' ? subtract(exitValue, entryValue) : subtract(entryValue, exitValue),
    );
  }
  const delta = input.type === 'Long' ? subtract(exit, entry) : subtract(entry, exit);
  return settle(multiply(delta, quantity));
}

/**
 * Exact exit value of partial exits, or null when there are none or they do not
 * cover the quantity. Used instead of the rounded average exit price, which
 * loses paise on large exits.
 */
function legsExitValue(legs, quantity) {
  if (!Array.isArray(legs) || legs.length < 2) return null;
  let total = { units: 0n, scale: 0 };
  let filled = 0;
  for (const leg of legs) {
    const price = decimal(leg?.price);
    const legQuantity = decimal(leg?.quantity);
    if (!price || !legQuantity) return null;
    total = add(total, multiply(price, legQuantity));
    filled += leg.quantity;
  }
  return filled === quantity ? total : null;
}

/**
 * Gross P&L, total charges and net P&L (gross − charges) in ₹, plus the charge breakdown.
 * Net is NaN when either input is invalid.
 */
export function computeTradeEconomics(input, config = DEFAULT_CHARGES) {
  const grossPnl = computeGrossPnl(input);
  const breakdown = computeCharges(input, config);
  const gross = decimal(grossPnl);
  const charges = decimal(breakdown.total);
  return {
    grossPnl,
    charges: breakdown.total,
    netPnl: gross && charges ? settle(subtract(gross, charges)) : NaN,
    breakdown,
  };
}

/** Economic edits use current charge settings; metadata edits preserve historical totals. */
export function tradeEconomicsChanged(original, input) {
  return (
    original.date !== input.date ||
    original.symbol !== input.symbol.trim().toUpperCase() ||
    original.type !== input.type ||
    original.entryPrice !== input.entryPrice ||
    original.exitPrice !== input.exitPrice ||
    original.quantity !== input.quantity ||
    // A different segment uses different charge rates (absent means equity).
    (original.segment ?? 'EQ') !== (input.segment ?? 'EQ') ||
    orderCount(original.entryOrders) !== orderCount(input.entryOrders) ||
    orderCount(original.exitOrders) !== orderCount(input.exitOrders)
  );
}

/**
 * Economics for a saved trade: a metadata-only edit keeps the original stored figures; a new
 * trade or an economic change is recomputed with `config`.
 */
export function economicsForTradeEdit(original, input, config) {
  if (original && !tradeEconomicsChanged(original, input)) {
    return { grossPnl: original.grossPnl, charges: original.charges, netPnl: original.pnl };
  }
  return computeTradeEconomics(input, config);
}

/* ---------------------------------- input validation --------------------------------- */

/**
 * Guards the journal against the NaN that used to poison the balance: an
 * unparseable price produced NaN P&L, which then propagated into every
 * downstream total permanently.
 */
export function parsePositiveNumber(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Field-keyed error messages for a trade form (symbol, date, prices with at most four decimals,
 * whole-number quantity); an empty object means valid.
 */
export function validateTradeInput(fields) {
  const errors = {};

  if (!fields.symbol.trim()) {
    errors.symbol = 'Symbol is required.';
  }
  if (!isBusinessDate(fields.date)) {
    errors.date = 'Enter a valid date.';
  }
  for (const key of ['entryPrice', 'exitPrice']) {
    const price = parsePositiveNumber(fields[key]);
    if (price === null) {
      errors[key] =
        `${key === 'entryPrice' ? 'Entry' : 'Exit'} price must be a number greater than zero.`;
    } else if (!/^\+?(?:\d+(?:\.\d{0,4}0*)?|\.\d{1,4}0*)$/.test(fields[key].trim())) {
      // Prices are kept to four decimals; more precision would let the saved
      // fill differ from the input the P&L was calculated from.
      errors[key] = 'Use a decimal price with at most four decimal places.';
    } else if (price >= 1e14) {
      errors[key] = 'Price exceeds the supported record range.';
    } else {
      const [whole = '', fraction = ''] = fields[key].trim().replace(/^\+/, '').split('.');
      const normalized = `${whole.replace(/^0+/, '') || '0'}.${fraction.padEnd(4, '0').slice(0, 4)}`;
      if (price.toFixed(4) !== normalized) {
        errors[key] = 'Price cannot be represented without losing decimal precision.';
      }
    }
  }
  const quantity = parsePositiveNumber(fields.quantity);
  if (quantity === null) {
    errors.quantity = 'Quantity must be a number greater than zero.';
  } else if (!Number.isInteger(quantity) || !/^\+?\d+(?:\.0*)?$/.test(fields.quantity.trim())) {
    errors.quantity = 'Quantity must be a whole number of shares.';
  } else if (quantity >= 1e14) {
    errors.quantity = 'Quantity exceeds the supported record range.';
  }

  return errors;
}

/** True when a validation errors object has any entries. */
export function hasErrors(errors) {
  return Object.keys(errors).length > 0;
}

/* ------------------------------------ aggregates ------------------------------------- */

/** Trades sorted oldest first, so an equity curve reads chronologically. */
export function sortTradesChronologically(trades) {
  return [...trades].sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    if (byDate !== 0) return byDate;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Win/loss counts, win rate (percent), and ₹ totals, averages and expectancy from net `pnl`.
 * profitFactor is null when there are no losses.
 */
export function summarisePerformance(trades) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  const netPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    grossPnl: round2(trades.reduce((sum, t) => sum + t.grossPnl, 0)),
    charges: round2(trades.reduce((sum, t) => sum + t.charges, 0)),
    netPnl: round2(netPnl),
    averageWin: wins.length ? round2(grossProfit / wins.length) : 0,
    averageLoss: losses.length ? round2(grossLoss / losses.length) : 0,
    // Undefined rather than Infinity when there are no losing trades: a
    // "profit factor of Infinity" reads as a bug to anyone looking at it.
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : null,
    expectancy: trades.length ? round2(netPnl / trades.length) : 0,
  };
}

/** Balance is always derived, never stored — see AccountSettings.openingBalance. */
export function computeCurrentBalance(openingBalance, trades) {
  return round2(trades.reduce((sum, t) => sum + t.pnl, openingBalance));
}

/** Running ₹ balance after each trade, oldest first, after a 'Start' point at the opening balance. */
export function buildEquityCurve(openingBalance, trades) {
  const ordered = sortTradesChronologically(trades);
  const points = [{ label: 'Start', balance: round2(openingBalance) }];
  let running = openingBalance;
  for (const trade of ordered) {
    running += trade.pnl;
    points.push({ label: `${trade.date} ${trade.symbol}`, balance: round2(running) });
  }
  return points;
}

/* --------------------------------- date ranges --------------------------------- */

export const RANGE_LABELS = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  ytd: 'This year',
  all: 'All time',
};

/**
 * The inclusive first date of a range as YYYY-MM-DD, or null for "all".
 *
 * Trade dates are stored as plain IST calendar dates with no time component, so
 * comparison is done on the string rather than by constructing Date objects,
 * which would drag the browser's timezone into an answer that must not depend
 * on it.
 */
export function rangeStart(range, today = new Date()) {
  if (range === 'all') return null;
  const businessDate = toIst(today).date.padStart(10, '0');
  if (range === 'ytd') return `${businessDate.slice(0, 4)}-01-01`;
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const start = new Date(`${businessDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start.toISOString().slice(0, 10);
}

/** Trades dated from the range's start through today's IST date; 'all' returns the input unfiltered. */
export function filterByRange(trades, range, today = new Date()) {
  const start = rangeStart(range, today);
  if (!start) return trades;
  const end = toIst(today).date.padStart(10, '0');
  return trades.filter((trade) => trade.date >= start && trade.date <= end);
}

/** Carry realised history into the selected period; no cash movements are inferred. */
export function periodOpeningBalance(openingBalance, trades, range, today = new Date()) {
  const start = rangeStart(range, today);
  return start
    ? computeCurrentBalance(
        openingBalance,
        trades.filter((trade) => trade.date < start),
      )
    : openingBalance;
}

/* --------------------------------- distributions -------------------------------- */

/**
 * Underwater curve: how far below the previous high-water mark the account sat
 * after each trade. Zero means a new peak.
 */
export function buildDrawdownCurve(openingBalance, trades) {
  const curve = buildEquityCurve(openingBalance, trades);
  let peak = -Infinity;
  return curve.map((point) => {
    peak = Math.max(peak, point.balance);
    return { label: point.label, drawdown: round2(point.balance - peak) };
  });
}

/** The largest peak-to-trough fall, as a positive number. Zero if never down. */
export function maxDrawdown(openingBalance, trades) {
  const curve = buildDrawdownCurve(openingBalance, trades);
  return round2(Math.abs(Math.min(0, ...curve.map((point) => point.drawdown))));
}

function groupBy(trades, keyOf) {
  const groups = new Map();
  for (const trade of trades) {
    const key = keyOf(trade);
    const existing = groups.get(key) ?? { key, netPnl: 0, trades: 0, wins: 0 };
    existing.netPnl += trade.pnl;
    existing.trades += 1;
    if (trade.pnl > 0) existing.wins += 1;
    groups.set(key, existing);
  }
  return [...groups.values()].map((group) => ({ ...group, netPnl: round2(group.netPnl) }));
}

/** Most profitable first, so the tail of the list is where the money leaks. */
export function pnlBySymbol(trades) {
  return groupBy(trades, (trade) => trade.symbol).sort((a, b) => b.netPnl - a.netPnl);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Kept in Monday-to-Friday order rather than sorted by P&L: a weekday chart is
 * read as a week, and weekdays with no trades still belong on it.
 */
export function pnlByWeekday(trades) {
  const grouped = groupBy(trades, (trade) => WEEKDAYS[new Date(`${trade.date}T00:00:00`).getDay()]);
  const bySlot = new Map(grouped.map((group) => [group.key, group]));
  return WEEKDAYS.slice(1, 6).map(
    (day) => bySlot.get(day) ?? { key: day, netPnl: 0, trades: 0, wins: 0 },
  );
}

/**
 * Win/loss distribution in fixed magnitude buckets. Shows whether the losses
 * are many small ones or a few that undid the whole month.
 */
export function pnlDistribution(trades) {
  const edges = [500, 2000, 5000];
  const labels = ['< ₹500', '₹500–2k', '₹2k–5k', '> ₹5k'];
  const buckets = [
    ...labels.map((label) => ({ label: `Loss ${label}`, count: 0 })).reverse(),
    ...labels.map((label) => ({ label: `Win ${label}`, count: 0 })),
  ];

  for (const trade of trades) {
    if (trade.pnl === 0) continue;
    const magnitude = Math.abs(trade.pnl);
    const tier = edges.findIndex((edge) => magnitude < edge);
    const index = tier === -1 ? 3 : tier;
    const bucket = trade.pnl > 0 ? buckets[4 + index] : buckets[3 - index];
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

/** The single best and worst trade, for the two numbers people look for first. */
export function bestAndWorst(trades) {
  if (trades.length === 0) return { best: null, worst: null };
  let best = trades[0];
  let worst = trades[0];
  for (const trade of trades) {
    if (trade.pnl > best.pnl) best = trade;
    if (trade.pnl < worst.pnl) worst = trade;
  }
  return { best, worst };
}
