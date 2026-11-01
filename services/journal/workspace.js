/**
 * Journal data access: loads a member's workspace snapshot, and creates, updates, imports and
 * deletes trades and watchlist items. Strategies and rules, screenshots and the AI chat have their
 * own files (re-exported below).
 */
import { z } from 'zod';
import {
  ChatMessage,
  Strategy,
  Trade,
  TradingRule,
  WatchlistItem,
  TRADE_SYMBOL_RE,
} from '../../models/index.js';
import {
  computeGrossPnl,
  economicsForTradeEdit,
  tradeEconomicsChanged,
  validateTradeInput,
} from '../../shared/pnl.js';
import { isBusinessDate } from '../../shared/business-dates.js';
import { EMOTION_VALUES, normalizeTags, parsePlannedRisk } from '../../shared/trade-tags.js';
import { chargesForSegment, contractDetails, lotProblem } from '../../shared/segments.js';
import { HttpError } from '../errors.js';
import { parseTradeExecution } from '../../shared/trade-execution.js';
import { loadAccountSettings } from './account-settings.js';
import { CHAT_HISTORY_LIMIT } from './chat.js';
import { discardScreenshot } from './screenshots.js';
import { toChatMessage, toRule, toStrategy, toTrade, toWatchlistItem } from './mappers.js';

// The rest of the journal lives in these files; re-exported for existing importers.
export { loadAccountSettings, saveAccountSettings, toAccountSettings } from './account-settings.js';
export * from './mappers.js';
export * from './screenshots.js';
export * from './strategies.js';
export * from './chat.js';

/* ---------------------------------- reads ---------------------------------- */

/** All of the member's trades, newest first; `tradeNotes: false` leaves notes empty (not loaded). */
export async function loadTrades(userId, { tradeNotes = true } = {}) {
  const query = Trade.find({ userId }).sort({ tradeDate: -1, _id: -1 });
  if (!tradeNotes) query.select('-notes');
  return (await query.lean()).map(toTrade);
}

/** The sum of the member's trades' net P&L, without loading the trades. */
export async function totalNetPnl(userId) {
  const [row] = await Trade.aggregate([
    { $match: { userId } },
    { $group: { _id: null, total: { $sum: '$netPnl' } } },
  ]);
  return row?.total ?? 0;
}
/** The member's strategies, latest trade date first. */
export async function loadStrategies(userId) {
  const rows = await Strategy.find({ userId }).sort({ tradeDate: -1, _id: -1 }).lean();
  return rows.map(toStrategy);
}
/** The member's trading rules, oldest first. */
export async function loadRules(userId) {
  const rows = await TradingRule.find({ userId }).sort({ createdAt: 1, _id: 1 }).lean();
  return rows.map(toRule);
}
/** The member's watchlist, in the order the symbols were added. */
export async function loadWatchlist(userId) {
  const rows = await WatchlistItem.find({ userId }).sort({ addedAt: 1, _id: 1 }).lean();
  return rows.map(toWatchlistItem);
}
/** The member's most recent CHAT_HISTORY_LIMIT chat messages, oldest first. */
export async function loadChat(userId) {
  const rows = await ChatMessage.find({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(CHAT_HISTORY_LIMIT)
    .lean();
  return rows.reverse().map(toChatMessage);
}

const WORKSPACE_LOADERS = {
  trades: loadTrades,
  strategies: loadStrategies,
  rules: loadRules,
  watchlist: loadWatchlist,
  chatMessages: loadChat,
  settings: loadAccountSettings,
};

/** Every part of a member's workspace snapshot. */
export const WORKSPACE_PARTS = Object.keys(WORKSPACE_LOADERS);

/**
 * The owner's workspace snapshot. Pass `parts` to load only what a page uses
 * (for example ['rules']); by default everything is loaded. `options` go to the
 * loaders (`tradeNotes`, see loadTrades).
 */
export async function loadWorkspace(userId, parts = WORKSPACE_PARTS, options = {}) {
  const values = await Promise.all(parts.map((part) => WORKSPACE_LOADERS[part](userId, options)));
  return Object.fromEntries(parts.map((part, index) => [part, values[index]]));
}

/* --------------------------------- trades ---------------------------------- */

const tradeInputSchema = z.object({
  date: z.string(),
  symbol: z.string(),
  type: z.enum(['Long', 'Short']),
  entryPrice: z.union([z.number(), z.string()]),
  exitPrice: z.union([z.number(), z.string()]),
  quantity: z.union([z.number(), z.string()]),
  notes: z.string().max(20000).default(''),
  strategyId: z.string().nullable().optional(),
  setupTags: z.union([z.array(z.string().max(200)).max(50), z.string().max(2000)]).optional(),
  mistakeTags: z.union([z.array(z.string().max(200)).max(50), z.string().max(2000)]).optional(),
  emotion: z.string().optional(),
  plannedRisk: z.union([z.number(), z.string(), z.null()]).optional(),
  segment: z.string().optional(),
  lotSize: z.union([z.number(), z.string(), z.null()]).optional(),
  expiry: z.string().nullable().optional(),
  strike: z.union([z.number(), z.string(), z.null()]).optional(),
  optionType: z.string().nullable().optional(),
  stopLoss: z.union([z.number(), z.string(), z.null()]).optional(),
  entryTime: z.string().max(5).nullable().optional(),
  exitTime: z.string().max(5).nullable().optional(),
  exitLegs: z
    .array(
      z.object({
        price: z.union([z.number(), z.string()]),
        quantity: z.union([z.number(), z.string()]),
      }),
    )
    .max(50)
    .optional(),
  entryOrders: z.union([z.number(), z.string(), z.null()]).optional(),
  exitOrders: z.union([z.number(), z.string(), z.null()]).optional(),
});

const EXECUTION_FIELDS = [
  'stopLoss',
  'entryTime',
  'exitTime',
  'exitLegs',
  'entryOrders',
  'exitOrders',
];

async function assertOwnedStrategy(userId, strategyId) {
  if (!strategyId) return null;
  const found = await Strategy.exists({ _id: strategyId, userId });
  if (!found) throw new HttpError('That strategy is no longer available.', 400);
  return strategyId;
}

/** Same validation and economics the trade form applies, now enforced on the server. */
function tradeDocument(input, settings, original) {
  const parsed = tradeInputSchema.safeParse(input);
  if (!parsed.success) throw new HttpError('Enter a complete trade.', 400);
  const fields = parsed.data;
  const errors = validateTradeInput({
    symbol: fields.symbol,
    date: fields.date,
    entryPrice: String(fields.entryPrice),
    exitPrice: String(fields.exitPrice),
    quantity: String(fields.quantity),
  });
  const problem = Object.values(errors)[0];
  if (problem) throw new HttpError(problem, 400, { fieldErrors: errors });
  const symbol = fields.symbol.trim().toUpperCase();
  if (!TRADE_SYMBOL_RE.test(symbol)) {
    throw new HttpError(
      'Symbol must use 1–25 letters, digits, dots, underscores or hyphens, starting with a letter or digit.',
      400,
    );
  }
  // Omitted contract fields keep the stored ones (equity for new trades).
  const contract = contractDetails(
    fields.segment === undefined && original
      ? original
      : {
          segment: fields.segment,
          lotSize: fields.lotSize,
          expiry: fields.expiry,
          strike: fields.strike,
          optionType: fields.optionType,
        },
  );
  const contractProblem =
    Object.values(contract.errors)[0] ?? lotProblem(fields.quantity, contract.values.lotSize);
  if (contractProblem) {
    throw new HttpError(contractProblem, 400, {
      fieldErrors: Object.keys(contract.errors).length
        ? contract.errors
        : { quantity: contractProblem },
    });
  }
  // Omitted execution fields keep the stored ones, like the review fields.
  const executionInput = Object.fromEntries(
    EXECUTION_FIELDS.map((key) => [key, fields[key] === undefined ? original?.[key] : fields[key]]),
  );
  const execution = parseTradeExecution(executionInput, {
    type: fields.type,
    entryPrice: Number(fields.entryPrice),
    quantity: Number(fields.quantity),
  });
  const executionProblem = Object.values(execution.errors)[0];
  if (executionProblem) {
    throw new HttpError(executionProblem, 400, { fieldErrors: execution.errors });
  }
  const values = {
    date: fields.date,
    symbol,
    type: fields.type,
    entryPrice: Number(fields.entryPrice),
    // Partial exits decide the exit price (their weighted average).
    exitPrice: execution.exitPrice ?? Number(fields.exitPrice),
    quantity: Number(fields.quantity),
    segment: contract.values.segment,
    entryOrders: execution.values.entryOrders,
    exitOrders: execution.values.exitOrders,
    exitLegs: execution.values.exitLegs,
  };
  const economics = economicsForTradeEdit(
    original,
    values,
    chargesForSegment(settings, contract.values.segment),
  );
  const emotion = fields.emotion ?? original?.emotion ?? '';
  if (!EMOTION_VALUES.includes(emotion))
    throw new HttpError('Choose an emotion from the list.', 400);
  const plannedRisk =
    fields.plannedRisk === undefined
      ? (original?.plannedRisk ?? null)
      : parsePlannedRisk(fields.plannedRisk);
  if (plannedRisk === undefined) {
    throw new HttpError('Planned risk must be a positive amount in rupees.', 400, {
      fieldErrors: { plannedRisk: 'Enter a positive amount in rupees.' },
    });
  }
  // Only the entered risk is stored; rMultiple falls back to the stop-loss distance.
  return {
    values,
    notes: fields.notes,
    strategyId: fields.strategyId ?? null,
    economics,
    // Omitted review fields keep their stored values, so older clients cannot erase them.
    contract: contract.values,
    review: {
      setupTags: normalizeTags(fields.setupTags ?? original?.setupTags ?? []),
      mistakeTags: normalizeTags(fields.mistakeTags ?? original?.mistakeTags ?? []),
      emotion,
      plannedRisk,
    },
    execution: execution.values,
  };
}

/**
 * Validates a new trade, computes its P&L with the member's current charge rates and saves it.
 * Throws HttpError 400 for invalid input or a strategy the member does not own.
 */
export async function createTrade(userId, input) {
  const settings = await loadAccountSettings(userId);
  const doc = tradeDocument(input, settings);
  const strategyId = await assertOwnedStrategy(userId, doc.strategyId);
  const trade = await Trade.create({
    userId,
    strategyId,
    tradeDate: doc.values.date,
    symbol: doc.values.symbol,
    direction: doc.values.type,
    entryPrice: doc.values.entryPrice,
    exitPrice: doc.values.exitPrice,
    quantity: doc.values.quantity,
    grossPnl: doc.economics.grossPnl,
    charges: doc.economics.charges,
    notes: doc.notes,
    ...doc.review,
    ...doc.contract,
    ...doc.execution,
  });
  return toTrade(trade.toObject());
}

/**
 * Economic edits use current charge settings; metadata-only edits preserve the
 * historical totals. An `expectedOriginal` snapshot rejects concurrent edits.
 */
export async function updateTrade(userId, id, input, expectedOriginal) {
  const stored = await Trade.findOne({ _id: id, userId }).lean();
  if (!stored)
    throw new HttpError('This trade is no longer available. Refresh before editing.', 404);
  const original = toTrade(stored);
  if (
    expectedOriginal &&
    typeof expectedOriginal === 'object' &&
    // Compared by value: review tags are arrays.
    Object.keys(expectedOriginal).some(
      (key) => JSON.stringify(expectedOriginal[key]) !== JSON.stringify(original[key]),
    )
  ) {
    throw new HttpError(
      'This trade changed while you were editing it. Reopen it to review the latest values.',
      409,
    );
  }
  const settings = await loadAccountSettings(userId);
  const doc = tradeDocument(input, settings, original);
  const strategyId = await assertOwnedStrategy(userId, doc.strategyId);
  if (!tradeEconomicsChanged(original, { ...doc.values })) {
    // Metadata changes never send historical economics back to storage.
    await Trade.updateOne(
      { _id: id, userId },
      {
        $set: {
          notes: doc.notes,
          strategyId,
          ...doc.review,
          ...doc.contract,
          ...doc.execution,
        },
      },
    );
  } else {
    const trade = await Trade.findOne({ _id: id, userId });
    Object.assign(trade, {
      strategyId,
      tradeDate: doc.values.date,
      symbol: doc.values.symbol,
      direction: doc.values.type,
      entryPrice: doc.values.entryPrice,
      exitPrice: doc.values.exitPrice,
      quantity: doc.values.quantity,
      grossPnl: doc.economics.grossPnl,
      charges: doc.economics.charges,
      notes: doc.notes,
      ...doc.review,
      ...doc.contract,
      ...doc.execution,
    });
    await trade.save();
  }
  return toTrade(await Trade.findOne({ _id: id, userId }).lean());
}

/**
 * Deletes one of the member's trades and its stored screenshot. Throws HttpError 404 when it does
 * not exist.
 */
export async function deleteTrade(userId, id) {
  const stored = await Trade.findOneAndDelete(
    { _id: id, userId },
    { projection: { screenshotPath: 1 } },
  );
  if (!stored) throw new HttpError('This trade is no longer available.', 404);
  if (stored.screenshotPath) await discardScreenshot(stored.screenshotPath);
}

const importTradeSchema = z
  .object({
    id: z.string().uuid(),
    date: z.string().refine(isBusinessDate),
    symbol: z.string().regex(TRADE_SYMBOL_RE),
    type: z.enum(['Long', 'Short']),
    entryPrice: z.number().finite().positive(),
    exitPrice: z.number().finite().positive(),
    quantity: z.number().int().positive(),
    grossPnl: z.number().finite(),
    charges: z.number().finite().nonnegative(),
    pnl: z.number().finite(),
    notes: z.string().max(20000),
    strategyId: z.null(),
    createdAt: z.string().datetime(),
    // F&O rows from a CSV (shared/csv.js); absent means equity.
    segment: z.enum(['FUT', 'OPT']).optional(),
    optionType: z.enum(['CE', 'PE']).optional(),
  })
  .strict()
  .refine((trade) => trade.segment !== 'OPT' || trade.optionType, 'An option needs CE or PE.');

export class ImportWriteError extends HttpError {
  constructor(message, outcome) {
    super(message, outcome === 'failed' ? 409 : 503, { outcome });
    this.name = 'ImportWriteError';
  }
}

/**
 * Insert only. Existing IDs are never updated, including trades edited after an
 * import. A duplicate ID is acknowledged only after an owner-scoped comparison.
 */
export async function importTrade(userId, input) {
  const parsed = importTradeSchema.safeParse(input);
  if (!parsed.success) {
    throw new ImportWriteError('This import row is invalid and was not saved.', 'failed');
  }
  const trade = parsed.data;
  const problem = Object.values(
    validateTradeInput({
      symbol: trade.symbol,
      date: trade.date,
      entryPrice: String(trade.entryPrice),
      exitPrice: String(trade.exitPrice),
      quantity: String(trade.quantity),
    }),
  )[0];
  const gross = computeGrossPnl(trade);
  if (
    problem ||
    gross !== trade.grossPnl ||
    Math.round((trade.grossPnl - trade.charges) * 100) / 100 !== trade.pnl
  ) {
    throw new ImportWriteError(
      problem || 'The import economics could not be verified. Review the file and retry.',
      'failed',
    );
  }
  const row = {
    _id: trade.id,
    userId,
    strategyId: null,
    tradeDate: trade.date,
    symbol: trade.symbol,
    direction: trade.type,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    quantity: trade.quantity,
    grossPnl: trade.grossPnl,
    charges: trade.charges,
    notes: trade.notes,
    createdAt: new Date(trade.createdAt),
    segment: trade.segment ?? 'EQ',
    optionType: trade.segment === 'OPT' ? (trade.optionType ?? null) : null,
  };
  try {
    await Trade.create(row);
    return 'inserted';
  } catch (error) {
    if (error?.code !== 11000) {
      throw new ImportWriteError(
        'The connection ended before the import outcome was known. Retry this batch.',
        'unknown',
      );
    }
  }
  const existing = await Trade.findOne({ _id: trade.id, userId }).lean();
  const matches =
    existing &&
    ['strategyId', 'tradeDate', 'symbol', 'direction', 'notes', 'segment'].every(
      (key) => existing[key] === row[key],
    ) &&
    ['entryPrice', 'exitPrice', 'quantity', 'grossPnl', 'charges'].every(
      (key) => Number(existing[key]) === Number(row[key]),
    ) &&
    new Date(existing.createdAt).getTime() === row.createdAt.getTime();
  if (!matches) {
    throw new ImportWriteError(
      'This import ID already exists with different data or cannot be verified. No existing trade was changed. Review the ledger before starting another import.',
      'failed',
    );
  }
  return 'already-present';
}

/* -------------------------------- watchlist --------------------------------- */

/**
 * Adds an NSE symbol to the member's watchlist, or returns the existing entry.
 * Throws HttpError 400 for an empty or invalid symbol.
 */
export async function addToWatchlist(userId, symbol) {
  const normalized = String(symbol ?? '')
    .trim()
    .toUpperCase();
  if (!normalized) throw new HttpError('Enter a symbol.', 400);
  if (!TRADE_SYMBOL_RE.test(normalized)) throw new HttpError('Enter a valid NSE symbol.', 400);
  const existing = await WatchlistItem.findOne({ userId, symbol: normalized }).lean();
  if (existing) return toWatchlistItem(existing);
  try {
    const item = await WatchlistItem.create({ userId, symbol: normalized });
    return toWatchlistItem(item.toObject());
  } catch (error) {
    if (error?.code === 11000) {
      return toWatchlistItem(await WatchlistItem.findOne({ userId, symbol: normalized }).lean());
    }
    throw error;
  }
}

/** Removes one item from the member's watchlist. Throws HttpError 404 when it does not exist. */
export async function removeFromWatchlist(userId, id) {
  const result = await WatchlistItem.deleteOne({ _id: id, userId });
  if (!result.deletedCount) throw new HttpError('This instrument is no longer listed.', 404);
}
