/**
 * Journal data access: loads a member's workspace snapshot and creates,
 * updates and deletes trades, strategies, rules and watchlist items.
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
import { MAX_STAGE_HISTORY, STAGE_VALUES } from '../../shared/strategy-stages.js';
import { parseTradeExecution } from '../../shared/trade-execution.js';
import { loadAccountSettings } from './account-settings.js';
import { removeObjects, tradeScreenshotPath, uploadObject } from '../storage.js';
import { iso } from '../../models/helpers.js';

// Settings live in account-settings.js; re-exported for existing importers.
export { loadAccountSettings, saveAccountSettings, toAccountSettings } from './account-settings.js';

/** Only the recent window of the chat history is loaded. */
export const CHAT_HISTORY_LIMIT = 200;
/** Messages kept per member; older ones are deleted as new ones arrive (the UI shows 200). */
export const CHAT_KEEP = 1000;
const CHAT_TEXT_MAX = 20_000;

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

/* ---------------------------------- reads ---------------------------------- */

/** All of the member's trades, newest first. */
export async function loadTrades(userId) {
  const rows = await Trade.find({ userId }).sort({ tradeDate: -1, _id: -1 }).lean();
  return rows.map(toTrade);
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
 * (for example ['rules']); by default everything is loaded.
 */
export async function loadWorkspace(userId, parts = WORKSPACE_PARTS) {
  const values = await Promise.all(parts.map((part) => WORKSPACE_LOADERS[part](userId)));
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
  if (stored.screenshotPath) await removeObjects('trade-screenshots', [stored.screenshotPath]);
}

/* ------------------------------ trade screenshots ------------------------------ */

/** Attach (or replace) the chart screenshot of one of the member's trades. */
export async function attachTradeScreenshot(userId, id, file) {
  if (!(await Trade.exists({ _id: id, userId }))) {
    throw new HttpError('This trade is no longer available.', 404);
  }
  const path = await uploadObject(
    'trade-screenshots',
    tradeScreenshotPath(userId, id),
    userId,
    file,
  );
  // Read the replaced path from the write itself: with two overlapping uploads,
  // each removes exactly the image it replaced, so none is left behind.
  const previous = await Trade.findOneAndUpdate(
    { _id: id, userId },
    { $set: { screenshotPath: path } },
    { new: false },
  ).lean();
  if (!previous) {
    // The trade was deleted while uploading; do not leave the image behind.
    await removeObjects('trade-screenshots', [path]);
    throw new HttpError('This trade is no longer available.', 404);
  }
  if (previous.screenshotPath && previous.screenshotPath !== path) {
    await removeObjects('trade-screenshots', [previous.screenshotPath]);
  }
  return toTrade({ ...previous, screenshotPath: path });
}

/** The stored screenshot path of a member's trade, or null. */
export async function tradeScreenshot(userId, id) {
  const stored = await Trade.findOne({ _id: id, userId }, { screenshotPath: 1 }).lean();
  if (!stored) throw new HttpError('This trade is no longer available.', 404);
  return stored.screenshotPath ?? null;
}

/**
 * Detaches the trade's screenshot and deletes the stored image. Throws HttpError 404 when the trade
 * does not exist.
 */
export async function removeTradeScreenshot(userId, id) {
  const stored = await Trade.findOneAndUpdate(
    { _id: id, userId },
    { $set: { screenshotPath: null } },
  ).lean();
  if (!stored) throw new HttpError('This trade is no longer available.', 404);
  if (stored.screenshotPath) await removeObjects('trade-screenshots', [stored.screenshotPath]);
  return toTrade({ ...stored, screenshotPath: null });
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

/* -------------------------------- strategies -------------------------------- */

const strategyInputSchema = z.object({
  date: z.string().refine(isBusinessDate, 'Enter a valid date.'),
  name: z.string().trim().min(1, 'Name is required.').max(120),
  rules: z.string().max(20000).default(''),
  improvements: z.string().max(20000).default(''),
  notes: z.string().max(20000).default(''),
});

function parseStrategy(input) {
  const parsed = strategyInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(parsed.error.issues[0]?.message || 'Enter a valid strategy.', 400);
  }
  return parsed.data;
}

/**
 * Validates and saves a new strategy for the member. Throws HttpError 400 with the first validation
 * message.
 */
export async function createStrategy(userId, input) {
  const value = parseStrategy(input);
  const strategy = await Strategy.create({
    userId,
    name: value.name,
    rules: value.rules,
    improvements: value.improvements,
    notes: value.notes,
    tradeDate: value.date,
  });
  return toStrategy(strategy.toObject());
}

/**
 * Replaces a strategy's editable fields. Throws HttpError 400 for invalid input, 404 when it is not
 * the member's.
 */
export async function updateStrategy(userId, id, input) {
  const value = parseStrategy(input);
  const updated = await Strategy.findOneAndUpdate(
    { _id: id, userId },
    {
      $set: {
        name: value.name,
        rules: value.rules,
        improvements: value.improvements,
        notes: value.notes,
        tradeDate: value.date,
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw new HttpError('This strategy is no longer available.', 404);
  return toStrategy(updated);
}

const stageSchema = z
  .object({
    stage: z.enum(STAGE_VALUES),
    note: z.string().trim().max(500).default(''),
  })
  .strict();

/** Moves a strategy to another stage and records the change. */
export async function setStrategyStage(userId, id, input) {
  const parsed = stageSchema.safeParse(input);
  if (!parsed.success) throw new HttpError('Choose a stage for this strategy.', 400);
  const { stage, note } = parsed.data;
  const updated = await Strategy.findOneAndUpdate(
    { _id: id, userId, stage: { $ne: stage } },
    {
      $set: { stage },
      $push: {
        stageHistory: { $each: [{ stage, at: new Date(), note }], $slice: -MAX_STAGE_HISTORY },
      },
    },
    { new: true },
  ).lean();
  if (updated) return toStrategy(updated);
  // Already at that stage (nothing to record), or not this member's.
  const current = await Strategy.findOne({ _id: id, userId }).lean();
  if (!current) throw new HttpError('This strategy is no longer available.', 404);
  return toStrategy(current);
}

/**
 * Deletes one of the member's strategies and unlinks it from their trades, which are kept. Throws
 * HttpError 404 when it does not exist.
 */
export async function deleteStrategy(userId, id) {
  const result = await Strategy.deleteOne({ _id: id, userId });
  if (!result.deletedCount) throw new HttpError('This strategy is no longer available.', 404);
  // Trades keep existing when their strategy is deleted; they just lose the link.
  await Trade.updateMany({ userId, strategyId: id }, { $set: { strategyId: null } });
}

/* ---------------------------------- rules ----------------------------------- */

const ruleInputSchema = z.object({
  section: z.string().trim().min(1, 'Section is required.').max(120),
  definition: z.string().max(20000).default(''),
  rule: z.string().trim().min(1, 'Rule is required.').max(4000),
});

function parseRule(input) {
  const parsed = ruleInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(parsed.error.issues[0]?.message || 'Enter a valid rule.', 400);
  }
  return parsed.data;
}

/** Validates and saves a new rule at the end of the member's rule list. */
export async function createRule(userId, input) {
  const value = parseRule(input);
  const position = await TradingRule.countDocuments({ userId });
  const rule = await TradingRule.create({ userId, ...value, position });
  return toRule(rule.toObject());
}

/**
 * Replaces a rule's section, definition and text. Throws HttpError 400 for invalid input, 404 when
 * it is not the member's.
 */
export async function updateRule(userId, id, input) {
  const value = parseRule(input);
  const updated = await TradingRule.findOneAndUpdate(
    { _id: id, userId },
    { $set: value },
    { new: true },
  ).lean();
  if (!updated) throw new HttpError('This rule is no longer available.', 404);
  return toRule(updated);
}

/** Deletes one of the member's rules. Throws HttpError 404 when it does not exist. */
export async function deleteRule(userId, id) {
  const result = await TradingRule.deleteOne({ _id: id, userId });
  if (!result.deletedCount) throw new HttpError('This rule is no longer available.', 404);
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

/* ----------------------------------- chat ----------------------------------- */

/** Saves one AI chat message (user or assistant) to the member's conversation history. */
export async function addChatMessage(userId, message) {
  const parsed = z
    .object({
      role: z.enum(['user', 'assistant']),
      text: z.string().max(100000),
      timestamp: z.string().datetime({ offset: true }).optional(),
    })
    .safeParse(message);
  if (!parsed.success) throw new HttpError('Invalid chat message.', 400);
  const saved = await ChatMessage.create({
    userId,
    role: parsed.data.role,
    // Long enough for any real answer; keeps one message from holding 100 KB.
    text: parsed.data.text.slice(0, CHAT_TEXT_MAX),
    createdAt: parsed.data.timestamp ? new Date(parsed.data.timestamp) : new Date(),
  });
  await trimChat(userId);
  return toChatMessage(saved.toObject());
}

/** Deletes a member's chat messages beyond the newest CHAT_KEEP (also after a restore). */
export async function trimChat(userId) {
  const cutoff = await ChatMessage.findOne({ userId }, { createdAt: 1 })
    .sort({ createdAt: -1, _id: -1 })
    .skip(CHAT_KEEP)
    .lean();
  if (!cutoff) return;
  const old = await ChatMessage.find({ userId, createdAt: { $lte: cutoff.createdAt } }, { _id: 1 })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  await ChatMessage.deleteMany({ userId, _id: { $in: old.map((row) => row._id) } });
}

/** Delete the full owner's conversation, including rows outside the recent UI window. */
export async function deleteChatHistory(userId) {
  if (!String(userId || '').trim()) {
    throw new HttpError('You must be signed in to clear your conversation.', 401);
  }
  await ChatMessage.deleteMany({ userId });
}
