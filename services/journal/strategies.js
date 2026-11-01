/**
 * The member's playbook: strategies (with their research stage) and trading rules.
 */
import { z } from 'zod';
import { Strategy, Trade, TradingRule } from '../../models/index.js';
import { isBusinessDate } from '../../shared/business-dates.js';
import { MAX_STAGE_HISTORY, STAGE_VALUES } from '../../shared/strategy-stages.js';
import { HttpError } from '../errors.js';
import { toRule, toStrategy } from './mappers.js';

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
