/**
 * Backtest evidence for strategies: schemas, validation and review labels.
 */
import { z } from 'zod';

import { runBacktest } from './backtest/engine.js';
import { isBusinessDate } from './business-dates.js';

const finite = z.number().finite();
const integer = finite.int().min(0).max(Number.MAX_SAFE_INTEGER);
const date = z.string().refine(isBusinessDate, 'Use a valid date.');
const uuid = z.string().uuid();
export const strategySnapshotSchema = z
  .object({
    id: uuid,
    date,
    name: z.string().min(3).max(120),
    rules: z.string().min(10),
    improvements: z.string(),
    notes: z.string(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
/**
 * The strategy fields an evidence snapshot records. A strategy also carries
 * its stage and stage history; those describe its life, not the rules that
 * were tested, so they are left out.
 */
export function strategySnapshotOf(strategy) {
  if (typeof strategy !== 'object' || strategy === null) return strategy;
  const { id, date, name, rules, improvements, notes, createdAt } = strategy;
  return { id, date, name, rules, improvements, notes, createdAt };
}

const params = z
  .object({
    kind: z.enum(['sma-cross', 'ema-cross', 'rsi-reversion']),
    fastPeriod: integer,
    slowPeriod: integer,
    rsiPeriod: integer,
    rsiOversold: finite,
    rsiOverbought: finite,
  })
  .strict();
const charges = z
  .object({
    enabled: z.boolean(),
    brokeragePercent: finite.nonnegative(),
    brokerageMaxPerOrder: finite.nonnegative(),
    sttPercent: finite.nonnegative(),
    exchangeTxnPercent: finite.nonnegative(),
    sebiPercent: finite.nonnegative(),
    gstPercent: finite.nonnegative(),
    stampDutyPercent: finite.nonnegative(),
  })
  .strict();
const metrics = z
  .object({
    totalTrades: integer,
    wins: integer,
    losses: integer,
    winRate: finite,
    netProfit: finite,
    grossProfit: finite,
    grossLoss: finite,
    totalCharges: finite,
    profitFactor: finite.nullable(),
    maxDrawdownPercent: finite,
    maxDrawdownValue: finite,
    averageWin: finite,
    averageLoss: finite,
    expectancy: finite,
    finalEquity: finite,
    returnPercent: finite,
    sharpeRatio: finite.nullable(),
    exposurePercent: finite,
  })
  .strict();
export const strategyEvidencePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    engineVersion: z.literal('blank-daily-long-v1'),
    provenance: z.literal('client-computed-unverified'),
    symbol: z.string().trim().min(1).max(40),
    from: date,
    to: date,
    params,
    config: z
      .object({
        initialCapital: finite.positive(),
        positionSizePercent: finite.positive().max(100),
        stopLossPercent: finite.nonnegative().lt(100),
        takeProfitPercent: finite.nonnegative(),
        charges,
      })
      .strict(),
    candles: z
      .array(
        z
          .object({
            time: integer,
            open: finite.positive(),
            high: finite.positive(),
            low: finite.positive(),
            close: finite.positive(),
            volume: finite.nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(3000),
    result: z
      .object({
        trades: z
          .array(
            z
              .object({
                entryTime: integer,
                exitTime: integer,
                entryPrice: finite.positive(),
                exitPrice: finite.positive(),
                quantity: integer.positive(),
                grossPnl: finite,
                charges: finite.nonnegative(),
                netPnl: finite,
                exitReason: z.enum(['signal', 'stop-loss', 'take-profit', 'end-of-data']),
              })
              .strict(),
          )
          .max(1500),
        equityCurve: z.array(z.object({ time: integer, equity: finite }).strict()).max(3000),
        metrics,
        warmupBars: integer,
      })
      .strict(),
  })
  .strict();

export const reviewDecisionSchema = z.enum(['approved_research', 'changes_requested', 'revoked']);

export const reviewSchema = z.object({
  id: uuid,
  user_id: uuid,
  evidence_id: uuid,
  decision: reviewDecisionSchema,
  notes: z.string().min(10).max(4000),
  expected_review_revision: integer,
  server_revision: integer.positive(),
  created_at: z.string().datetime({ offset: true }),
});

export const evidenceRecordSchema = z.object({
  id: uuid,
  user_id: uuid,
  strategy_id: uuid,
  strategy_snapshot: strategySnapshotSchema,
  strategy_hash: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: strategyEvidencePayloadSchema,
  evidence_hash: z.string().regex(/^[a-f0-9]{64}$/),
  server_revision: integer.positive(),
  created_at: z.string().datetime({ offset: true }),
  latest_review: reviewSchema.nullable().optional(),
});

/** Recompute before saving. The server still labels this client evidence as unverified. */
export function validateStrategyEvidence(snapshot, input) {
  strategySnapshotSchema.parse(snapshot);
  const value = strategyEvidencePayloadSchema.parse(input);
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).length > 30000 ||
    new TextEncoder().encode(JSON.stringify(value)).length > 480000
  ) {
    throw new Error('This simulation exceeds the saved-evidence limit. Use a shorter date range.');
  }
  const start = Date.parse(`${value.from}T00:00:00Z`);
  const end = Date.parse(`${value.to}T00:00:00Z`);
  if (start >= end || value.candles.some((candle) => candle.time < start || candle.time >= end)) {
    throw new Error('The archived candles must match the completed date range.');
  }
  const computed = strategyEvidencePayloadSchema.shape.result.parse(
    runBacktest(value.candles, value.params, value.config),
  );
  if (JSON.stringify(computed) !== JSON.stringify(value.result)) {
    throw new Error(
      'The simulation results no longer match their captured inputs. Run a new backtest.',
    );
  }
  return value;
}

/**
 * True when the current strategy still has the snapshot's id, date, name, rules, improvements,
 * notes and creation time, i.e. the evidence still describes it.
 */
export function matchesStrategySnapshot(current, snapshot) {
  return Boolean(
    current &&
    current.id === snapshot.id &&
    current.date === snapshot.date &&
    current.name === snapshot.name &&
    current.rules === snapshot.rules &&
    current.improvements === snapshot.improvements &&
    current.notes === snapshot.notes &&
    Date.parse(current.createdAt) === Date.parse(snapshot.createdAt),
  );
}
export const REVIEW_LABELS = {
  approved_research: 'Owner approved for research',
  changes_requested: 'Changes requested',
  revoked: 'Research approval revoked',
};
