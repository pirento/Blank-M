/**
 * Data backup: export everything a member owns as one JSON file, and restore a
 * backup without changing or deleting existing records.
 */
import { parseTradeExecution } from '../../shared/trade-execution.js';
import { MAX_STAGE_HISTORY, STAGE_VALUES } from '../../shared/strategy-stages.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ChatMessage,
  OrderPlanRecord,
  Strategy,
  StrategyEvidence,
  StrategyEvidenceReview,
  Trade,
  TradingRule,
  WatchlistItem,
  nextSequence,
} from '../../models/index.js';
import { TRADE_SYMBOL_RE } from '../../models/Trade.js';
import { computeGrossPnl, validateTradeInput } from '../../shared/pnl.js';
import { isBusinessDate } from '../../shared/business-dates.js';
import { validateOrderPlanRecord } from '../../shared/order-plans.js';
import { EMOTION_VALUES, normalizeTags, parsePlannedRisk } from '../../shared/trade-tags.js';
import { contractDetails } from '../../shared/segments.js';
import { HttpError } from '../errors.js';
import {
  loadAccountSettings,
  saveAccountSettings,
  toChatMessage,
  toRule,
  toStrategy,
  toTrade,
  toWatchlistItem,
} from './workspace.js';

export const BACKUP_FORMAT = 'pirento-blank-backup';
/**
 * Execution details from a backup. A field that does not validate is dropped on
 * its own; the others (stop-loss, times, orders) are kept.
 */
export function restoredExecution(trade) {
  const { values, errors } = parseTradeExecution(trade, trade);
  for (const key of Object.keys(errors)) values[key] = key === 'exitLegs' ? [] : null;
  return values;
}

const BACKUP_VERSION = 1;
const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * Everything the member owns, in one JSON document. Order plans and strategy
 * evidence are included as an archive; the evidence is not restored because it
 * is bound to the exact strategy revision it was saved against.
 */
export async function buildBackup(userId, email) {
  const [settings, trades, strategies, rules, watchlist, chat, plans, evidence, reviews] =
    await Promise.all([
      loadAccountSettings(userId),
      Trade.find({ userId }).sort({ tradeDate: 1, createdAt: 1 }).lean(),
      Strategy.find({ userId }).sort({ createdAt: 1 }).lean(),
      TradingRule.find({ userId }).sort({ position: 1, createdAt: 1 }).lean(),
      WatchlistItem.find({ userId }).sort({ addedAt: 1 }).lean(),
      ChatMessage.find({ userId }).sort({ createdAt: 1 }).lean(),
      OrderPlanRecord.find({ userId }).sort({ serverRevision: 1 }).lean(),
      StrategyEvidence.find({ userId }).sort({ serverRevision: 1 }).lean(),
      StrategyEvidenceReview.find({ userId }).sort({ serverRevision: 1 }).lean(),
    ]);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    account: { id: userId, email },
    settings,
    trades: trades.map(toTrade),
    strategies: strategies.map(toStrategy),
    rules: rules.map(toRule),
    watchlist: watchlist.map(toWatchlistItem),
    chatMessages: chat.map(toChatMessage),
    orderPlans: plans.map((row) => ({
      record_key: row.recordKey,
      record_kind: row.recordKind,
      record: row.record,
    })),
    strategyEvidence: evidence.map((row) => ({
      id: row._id,
      strategyId: row.strategyId,
      strategySnapshot: row.strategySnapshot,
      evidence: row.evidence,
      evidenceHash: row.evidenceHash,
      createdAt: iso(row.createdAt),
      reviews: reviews
        .filter((review) => review.evidenceId === row._id)
        .map((review) => ({
          id: review._id,
          decision: review.decision,
          notes: review.notes,
          createdAt: iso(review.createdAt),
        })),
    })),
  };
}

const text = (max) => z.string().max(max).default('');
const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  account: z.object({ id: z.string(), email: z.string() }).partial().optional(),
  settings: z.unknown().optional(),
  trades: z
    .array(
      z.object({
        id: z.string().uuid(),
        date: z.string(),
        symbol: z.string(),
        type: z.enum(['Long', 'Short']),
        entryPrice: z.number().finite(),
        exitPrice: z.number().finite(),
        quantity: z.number().finite(),
        grossPnl: z.number().finite(),
        charges: z.number().finite().nonnegative(),
        notes: text(20000),
        strategyId: z.string().uuid().nullable().default(null),
        createdAt: z.string().datetime({ offset: true }).nullable().default(null),
        // Review fields (absent in older backups).
        setupTags: z.array(z.string().max(200)).max(50).default([]),
        mistakeTags: z.array(z.string().max(200)).max(50).default([]),
        emotion: z.string().default(''),
        plannedRisk: z.number().nullable().default(null),
        // F&O contract details (absent in older backups: equity).
        segment: z.enum(['EQ', 'FUT', 'OPT']).default('EQ'),
        lotSize: z.number().nullable().default(null),
        expiry: z.string().nullable().default(null),
        strike: z.number().nullable().default(null),
        optionType: z.enum(['CE', 'PE']).nullable().default(null),
        // Execution details (absent in older backups).
        stopLoss: z.number().nullable().default(null),
        entryTime: z.string().nullable().default(null),
        exitTime: z.string().nullable().default(null),
        exitLegs: z
          .array(z.object({ price: z.number(), quantity: z.number() }))
          .max(50)
          .default([]),
        entryOrders: z.number().nullable().default(null),
        exitOrders: z.number().nullable().default(null),
      }),
    )
    .max(50000)
    .default([]),
  strategies: z
    .array(
      z.object({
        id: z.string().uuid(),
        date: z.string().refine(isBusinessDate),
        name: z.string().trim().min(1).max(120),
        rules: text(20000),
        improvements: text(20000),
        notes: text(20000),
        createdAt: z.string().datetime({ offset: true }).nullable().default(null),
        // Stage (absent in older backups: draft).
        stage: z.enum(STAGE_VALUES).catch('draft').default('draft'),
        stageHistory: z
          .array(
            z.object({
              stage: z.enum(STAGE_VALUES),
              at: z.string().datetime({ offset: true }),
              note: z.string().max(500).default(''),
            }),
          )
          .max(MAX_STAGE_HISTORY)
          .catch([])
          .default([]),
      }),
    )
    .max(5000)
    .default([]),
  rules: z
    .array(
      z.object({
        id: z.string(),
        section: z.string().trim().min(1).max(120),
        definition: text(20000),
        rule: z.string().trim().min(1).max(4000),
      }),
    )
    .max(1000)
    .default([]),
  watchlist: z
    .array(z.object({ symbol: z.string() }))
    .max(1000)
    .default([]),
  chatMessages: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(['user', 'assistant']),
        text: z.string().max(100000),
        timestamp: z.string().datetime({ offset: true }).nullable().default(null),
      }),
    )
    .max(20000)
    .default([]),
  orderPlans: z.array(z.unknown()).max(20000).default([]),
});

/** A UUID-shaped identifier derived from the target account and the original ID. */
function derivedId(userId, id) {
  const hex = createHash('sha256').update(`blank-restore-v1:${userId}:${id}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Stored economics are kept, but only when they agree with the trade itself. */
function tradeIsConsistent(trade) {
  const problems = validateTradeInput({
    symbol: trade.symbol,
    date: trade.date,
    entryPrice: String(trade.entryPrice),
    exitPrice: String(trade.exitPrice),
    quantity: String(trade.quantity),
  });
  if (Object.keys(problems).length) return false;
  if (!TRADE_SYMBOL_RE.test(trade.symbol.trim().toUpperCase())) return false;
  // Older trades with partial exits were valued at the rounded average exit price.
  return (
    computeGrossPnl(trade) === trade.grossPnl ||
    computeGrossPnl({ ...trade, exitLegs: [] }) === trade.grossPnl
  );
}

/**
 * Add the backup's records to this account. Existing records are never changed
 * or deleted; records already present are skipped, so restoring twice is safe.
 * IDs owned by another account are replaced with new ones.
 */
export async function restoreBackup(userId, raw, { includeSettings = false } = {}) {
  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError('This file is not a valid Pirento Blank backup.', 400);
  }
  const backup = parsed.data;
  const summary = {};
  const count = (section, key) => {
    summary[section] ??= { added: 0, skipped: 0, invalid: 0 };
    summary[section][key] += 1;
  };

  /**
   * Reuse the backup's ID when free or already ours. An ID owned by another
   * account maps to a stable per-account ID, so restoring twice never duplicates.
   */
  async function placement(model, id) {
    const existing = await model.findById(id, { userId: 1 }).lean();
    if (!existing) return { id, present: false };
    if (existing.userId === userId) return { id, present: true };
    const derived = derivedId(userId, id);
    return { id: derived, present: Boolean(await model.exists({ _id: derived, userId })) };
  }

  const strategyIds = new Map();
  for (const strategy of backup.strategies) {
    const target = await placement(Strategy, strategy.id);
    strategyIds.set(strategy.id, target.id);
    if (target.present) {
      count('strategies', 'skipped');
      continue;
    }
    await Strategy.create({
      _id: target.id,
      userId,
      name: strategy.name,
      rules: strategy.rules,
      improvements: strategy.improvements,
      notes: strategy.notes,
      tradeDate: strategy.date,
      stage: strategy.stage,
      stageHistory: strategy.stageHistory.map((entry) => ({ ...entry, at: new Date(entry.at) })),
      ...(strategy.createdAt ? { createdAt: new Date(strategy.createdAt) } : {}),
    });
    count('strategies', 'added');
  }

  for (const trade of backup.trades) {
    if (!tradeIsConsistent(trade)) {
      count('trades', 'invalid');
      continue;
    }
    const target = await placement(Trade, trade.id);
    if (target.present) {
      count('trades', 'skipped');
      continue;
    }
    const mapped = trade.strategyId ? strategyIds.get(trade.strategyId) : null;
    const strategyId =
      mapped ??
      (trade.strategyId && (await Strategy.exists({ _id: trade.strategyId, userId }))
        ? trade.strategyId
        : null);
    await Trade.create({
      _id: target.id,
      userId,
      strategyId,
      tradeDate: trade.date,
      symbol: trade.symbol.trim().toUpperCase(),
      direction: trade.type,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      quantity: trade.quantity,
      grossPnl: trade.grossPnl,
      charges: trade.charges,
      notes: trade.notes,
      setupTags: normalizeTags(trade.setupTags),
      mistakeTags: normalizeTags(trade.mistakeTags),
      emotion: EMOTION_VALUES.includes(trade.emotion) ? trade.emotion : '',
      plannedRisk: parsePlannedRisk(trade.plannedRisk) ?? null,
      ...contractDetails(trade).values,
      ...restoredExecution(trade),
      ...(trade.createdAt ? { createdAt: new Date(trade.createdAt) } : {}),
    });
    count('trades', 'added');
  }

  const existingRules = await TradingRule.find({ userId }, { section: 1, rule: 1 }).lean();
  const ruleKeys = new Set(existingRules.map((rule) => `${rule.section}\u0000${rule.rule}`));
  let position = await TradingRule.countDocuments({ userId });
  for (const rule of backup.rules) {
    const key = `${rule.section}\u0000${rule.rule}`;
    if (ruleKeys.has(key)) {
      count('rules', 'skipped');
      continue;
    }
    ruleKeys.add(key);
    await TradingRule.create({
      userId,
      section: rule.section,
      definition: rule.definition,
      rule: rule.rule,
      position: position++,
    });
    count('rules', 'added');
  }

  for (const item of backup.watchlist) {
    const symbol = item.symbol.trim().toUpperCase();
    if (!TRADE_SYMBOL_RE.test(symbol)) {
      count('watchlist', 'invalid');
      continue;
    }
    const result = await WatchlistItem.updateOne(
      { userId, symbol },
      { $setOnInsert: { userId, symbol } },
      { upsert: true },
    );
    count('watchlist', result.upsertedCount ? 'added' : 'skipped');
  }

  const chatKeys = new Set(
    (await ChatMessage.find({ userId }, { role: 1, text: 1, createdAt: 1 }).lean()).map(
      (message) => `${message.role}\u0000${iso(message.createdAt)}\u0000${message.text}`,
    ),
  );
  for (const message of backup.chatMessages) {
    const key = `${message.role}\u0000${message.timestamp}\u0000${message.text}`;
    if (chatKeys.has(key)) {
      count('chatMessages', 'skipped');
      continue;
    }
    chatKeys.add(key);
    await ChatMessage.create({
      userId,
      role: message.role,
      text: message.text,
      ...(message.timestamp ? { createdAt: new Date(message.timestamp) } : {}),
    });
    count('chatMessages', 'added');
  }

  // Frozen plans name their owner, so they can only return to the same account.
  for (const row of backup.orderPlans) {
    let valid;
    try {
      valid = validateOrderPlanRecord(userId, { ...row, user_id: userId });
    } catch {
      count('orderPlans', 'invalid');
      continue;
    }
    if (await OrderPlanRecord.exists({ userId, recordKey: valid.record_key })) {
      count('orderPlans', 'skipped');
      continue;
    }
    await OrderPlanRecord.create({
      userId,
      recordKey: valid.record_key,
      recordKind: valid.record_kind,
      record: valid.record,
      serverRevision: await nextSequence('order_plan_records'),
    });
    count('orderPlans', 'added');
  }

  if (includeSettings && backup.settings && typeof backup.settings === 'object') {
    const { openingBalance, charges, foCharges, riskLimits } = backup.settings;
    await saveAccountSettings(userId, { openingBalance, charges, foCharges, riskLimits });
    summary.settings = { added: 1, skipped: 0, invalid: 0 };
  }
  return summary;
}
