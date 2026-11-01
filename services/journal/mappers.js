/**
 * Stored journal documents → the plain objects the API and browser use.
 */
import { iso } from '../../models/helpers.js';

/** Stored numbers can arrive as strings in some paths; normalise. */
function num(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/* ---------------------------------- mappers --------------------------------- */

/** A stored Trade document → the plain trade object the API and browser use (net P&L, review and execution fields). */
export function toTrade(row) {
  const grossPnl = num(row.grossPnl);
  const charges = num(row.charges);
  return {
    id: row._id,
    date: row.tradeDate,
    symbol: row.symbol,
    type: row.direction === 'Short' ? 'Short' : 'Long',
    entryPrice: num(row.entryPrice),
    exitPrice: num(row.exitPrice),
    quantity: num(row.quantity),
    grossPnl,
    charges,
    pnl: num(row.netPnl, grossPnl - charges),
    notes: row.notes ?? '',
    strategyId: row.strategyId ?? null,
    setupTags: row.setupTags ?? [],
    mistakeTags: row.mistakeTags ?? [],
    emotion: row.emotion ?? '',
    plannedRisk: row.plannedRisk ?? null,
    hasScreenshot: Boolean(row.screenshotPath),
    segment: row.segment ?? 'EQ',
    lotSize: row.lotSize ?? null,
    expiry: row.expiry ?? null,
    strike: row.strike ?? null,
    optionType: row.optionType ?? null,
    stopLoss: row.stopLoss ?? null,
    entryTime: row.entryTime ?? null,
    exitTime: row.exitTime ?? null,
    exitLegs: (row.exitLegs ?? []).map((leg) => ({ price: leg.price, quantity: leg.quantity })),
    entryOrders: row.entryOrders ?? null,
    exitOrders: row.exitOrders ?? null,
    createdAt: iso(row.createdAt),
  };
}

/** API shape of a stored strategy, including its stage history. */
export function toStrategy(row) {
  return {
    id: row._id,
    date: row.tradeDate,
    name: row.name,
    rules: row.rules ?? '',
    improvements: row.improvements ?? '',
    notes: row.notes ?? '',
    stage: row.stage ?? 'draft',
    stageHistory: (row.stageHistory ?? []).map((entry) => ({
      stage: entry.stage,
      at: iso(entry.at),
      note: entry.note ?? '',
    })),
    createdAt: iso(row.createdAt),
  };
}

/** API shape of a stored trading rule. */
export function toRule(row) {
  return {
    id: row._id,
    section: row.section,
    definition: row.definition ?? '',
    rule: row.rule,
    createdAt: iso(row.createdAt),
  };
}

/** API shape of a stored watchlist item. */
export function toWatchlistItem(row) {
  return { id: row._id, symbol: row.symbol, addedAt: iso(row.addedAt) };
}

/** API shape of a stored chat message; any role other than 'assistant' reads as 'user'. */
export function toChatMessage(row) {
  return {
    id: row._id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    text: row.text ?? '',
    timestamp: iso(row.createdAt),
  };
}
