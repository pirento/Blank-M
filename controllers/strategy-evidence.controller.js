/**
 * Backtest evidence for strategies: save evidence, list it, and append or list
 * reviews. Records are append-only.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  Strategy,
  StrategyEvidence,
  StrategyEvidenceReview,
  nextSequence,
} from '../models/index.js';
import {
  evidenceRecordSchema,
  reviewDecisionSchema,
  reviewSchema,
  strategySnapshotOf,
  validateStrategyEvidence,
} from '../shared/strategy-evidence.js';
import { toStrategy } from '../services/journal/workspace.js';
import { HttpError } from '../services/errors.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const iso = (value) => new Date(value).toISOString();
const SEQUENCE = 'strategy_evidence_revision';

/** The server's own snapshot of the current draft; key order is fixed for hashing. */
function researchSnapshot(strategy) {
  const value = toStrategy(strategy);
  return {
    id: value.id,
    date: value.date,
    name: value.name,
    rules: value.rules,
    improvements: value.improvements,
    notes: value.notes,
    createdAt: value.createdAt,
  };
}

function reviewJson(row) {
  return reviewSchema.parse({
    id: row._id,
    user_id: row.userId,
    evidence_id: row.evidenceId,
    decision: row.decision,
    notes: row.notes,
    expected_review_revision: row.expectedReviewRevision,
    server_revision: row.serverRevision,
    created_at: iso(row.createdAt),
  });
}

async function latestReview(userId, evidenceId) {
  return StrategyEvidenceReview.findOne({ userId, evidenceId }).sort({ serverRevision: -1 }).lean();
}

async function evidenceJson(row) {
  const latest = await latestReview(row.userId, row._id);
  return evidenceRecordSchema.parse({
    id: row._id,
    user_id: row.userId,
    strategy_id: row.strategyId,
    strategy_snapshot: row.strategySnapshot,
    strategy_hash: row.strategyHash,
    evidence: row.evidence,
    evidence_hash: row.evidenceHash,
    server_revision: row.serverRevision,
    created_at: iso(row.createdAt),
    latest_review: latest ? reviewJson(latest) : null,
  });
}

/**
 * Save immutable research evidence. The simulation is recomputed from its
 * frozen inputs and must belong to the owner's current, unchanged draft.
 */
export async function saveEvidence(req, res) {
  const userId = req.member.userId;
  const input = z
    .object({ id: z.string().uuid(), snapshot: z.unknown(), evidence: z.unknown() })
    .safeParse(req.body);
  if (!input.success) throw new HttpError('Invalid or oversized research evidence.', 400);
  // Older and newer clients may send the whole strategy; keep the recorded fields.
  input.data.snapshot = strategySnapshotOf(input.data.snapshot);
  let evidence;
  try {
    evidence = validateStrategyEvidence(input.data.snapshot, input.data.evidence);
  } catch (error) {
    throw new HttpError(
      error instanceof Error && !(error instanceof z.ZodError)
        ? error.message
        : 'Invalid or oversized research evidence.',
      400,
    );
  }
  const snapshot = input.data.snapshot;
  const evidenceHash = sha256(JSON.stringify(evidence));
  const existing = await StrategyEvidence.findById(input.data.id).lean();
  if (existing) {
    if (
      existing.userId !== userId ||
      existing.strategyId !== snapshot.id ||
      existing.evidenceHash !== evidenceHash ||
      JSON.stringify(existing.strategySnapshot) !== JSON.stringify(snapshot)
    ) {
      throw new HttpError('Evidence request already has different inputs.', 409);
    }
    res.json({ record: await evidenceJson(existing) });
    return;
  }
  const source = await Strategy.findOne({ _id: snapshot.id, userId }).lean();
  if (!source) throw new HttpError('The saved strategy is no longer available.', 409);
  const current = researchSnapshot(source);
  const { createdAt: currentCreated, ...currentRest } = current;
  const { createdAt: snapshotCreated, ...snapshotRest } = snapshot;
  if (
    JSON.stringify(currentRest) !== JSON.stringify(snapshotRest) ||
    Date.parse(currentCreated) !== Date.parse(snapshotCreated)
  ) {
    throw new HttpError('Strategy changed. Run a new simulation against the current draft.', 409);
  }
  let saved;
  try {
    saved = await StrategyEvidence.create({
      _id: input.data.id,
      userId,
      strategyId: source._id,
      strategySnapshot: snapshot,
      strategyHash: sha256(JSON.stringify(current)),
      evidence,
      evidenceHash,
      serverRevision: await nextSequence(SEQUENCE),
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HttpError('Evidence request already has different inputs.', 409);
    }
    throw error;
  }
  res.status(201).json({ record: await evidenceJson(saved.toObject()) });
}

/** Two bounded evidence records per page; evidence for deleted drafts stays reachable. */
export async function listEvidence(req, res) {
  const before = req.query.before === undefined ? null : Number(req.query.before);
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
    throw new HttpError('Invalid evidence cursor.', 400);
  }
  const rows = await StrategyEvidence.find({
    userId: req.member.userId,
    ...(before ? { serverRevision: { $lt: before } } : {}),
  })
    .sort({ serverRevision: -1 })
    .limit(3)
    .lean();
  const items = await Promise.all(rows.slice(0, 2).map(evidenceJson));
  res.json({ items, hasMore: rows.length > 2 });
}

/** Append-only owner decision with optimistic latest-review revision. */
export async function appendReview(req, res) {
  const userId = req.member.userId;
  const input = z
    .object({
      id: z.string().uuid(),
      decision: reviewDecisionSchema,
      notes: z.string(),
      expectedRevision: z.number().int().min(0),
      confirmed: z.literal(true),
    })
    .safeParse(req.body);
  const notes = input.success ? input.data.notes.trim() : '';
  if (!input.success || notes.length < 10 || notes.length > 4000) {
    throw new HttpError('Confirm a research-only decision and write review notes.', 400);
  }
  const evidenceId = req.params.id;
  const replay = await StrategyEvidenceReview.findById(input.data.id).lean();
  if (replay) {
    if (
      replay.userId !== userId ||
      replay.evidenceId !== evidenceId ||
      replay.decision !== input.data.decision ||
      replay.notes !== notes ||
      replay.expectedReviewRevision !== input.data.expectedRevision
    ) {
      throw new HttpError('Review request already has a different decision.', 409);
    }
    // A replay returns the CURRENT decision, never an older replayed approval.
    res.json({ review: reviewJson(await latestReview(userId, evidenceId)) });
    return;
  }
  const evidence = await StrategyEvidence.findOne({ _id: evidenceId, userId }).lean();
  if (!evidence) throw new HttpError('Research evidence is unavailable.', 403);
  const latest = await latestReview(userId, evidenceId);
  if ((latest?.serverRevision ?? 0) !== input.data.expectedRevision) {
    throw new HttpError(
      'Another review was saved. Reload the evidence before reviewing again.',
      409,
    );
  }
  if (input.data.decision !== 'revoked') {
    const source = await Strategy.findOne({ _id: evidence.strategyId, userId }).lean();
    if (!source || sha256(JSON.stringify(researchSnapshot(source))) !== evidence.strategyHash) {
      throw new HttpError(
        'Strategy changed or was deleted. This evidence cannot approve the current draft.',
        409,
      );
    }
  }
  const saved = await StrategyEvidenceReview.create({
    _id: input.data.id,
    userId,
    evidenceId,
    decision: input.data.decision,
    notes,
    expectedReviewRevision: input.data.expectedRevision,
    serverRevision: await nextSequence(SEQUENCE),
  });
  res.status(201).json({ review: reviewJson(saved.toObject()) });
}

/**
 * GET /api/strategy-evidence/:id/reviews?before=: the evidence's reviews, 20 per page by
 * descending server revision; `before` is the revision to continue below. 400 for a bad cursor.
 */
export async function listReviews(req, res) {
  const before = req.query.before === undefined ? null : Number(req.query.before);
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
    throw new HttpError('Invalid review cursor.', 400);
  }
  const rows = await StrategyEvidenceReview.find({
    userId: req.member.userId,
    evidenceId: req.params.id,
    ...(before ? { serverRevision: { $lt: before } } : {}),
  })
    .sort({ serverRevision: -1 })
    .limit(21)
    .lean();
  res.json({ items: rows.slice(0, 20).map(reviewJson), hasMore: rows.length > 20 });
}
