/**
 * Saved research runs in MongoDB. One run per (member, request ID): begin it
 * once, then finish or fail it; completed runs keep the exact universe snapshot
 * and inputs they were produced from. Callers map ArchiveRefusal reasons to
 * HTTP errors (see services/ai/research-archive.js).
 */
import { isDeepStrictEqual } from 'node:util';
import { ResearchRun, User, nextSequence } from '../../models/index.js';

/** Saved runs returned per history page. */
export const HISTORY_LIMIT = 50;

/**
 * A refused archive operation. `code` is one of: forbidden (inactive member),
 * conflict (request exists with other inputs or a final outcome), bad-cursor
 * (unknown history cursor) or invalid (malformed request).
 */
export class ArchiveRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** ISO-8601 string for a date-like value, or null when it is empty. */
export const iso = (value) => (value ? new Date(value).toISOString() : null);

/** The stored run in the archive's public JSON shape. */
function runJson(row) {
  return {
    id: row._id,
    requestId: row.requestId,
    ownerId: row.userId,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    outcome: row.outcome,
    inputs: row.inputs,
    universe: row.universe,
    picks: row.picks ?? [],
    sources: row.sources ?? [],
  };
}

async function requireActiveResearchOwner(userId) {
  const owner = await User.findById(userId, { status: 1 }).lean();
  if (!owner || owner.status !== 'active') {
    throw new ArchiveRefusal('forbidden', 'Active workspace membership is required.');
  }
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function validBeginRequest(inputs, universe) {
  const prompt = inputs?.prompt;
  const metadata = universe?.metadata;
  const constituents = universe?.constituents;
  if (
    !inputs ||
    typeof inputs.strategies !== 'string' ||
    typeof inputs.rules !== 'string' ||
    inputs.strategies.length > 20000 ||
    inputs.rules.length > 20000 ||
    !Number.isInteger(inputs.count) ||
    inputs.count < 1 ||
    inputs.count > 10
  )
    throw new ArchiveRefusal('invalid', 'Invalid research request inputs.');
  if (
    !metadata ||
    metadata.name !== 'NIFTY 500' ||
    metadata.sourceUrl !==
      'https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv' ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata.version ?? '') ||
    !Array.isArray(constituents)
  )
    throw new ArchiveRefusal('invalid', 'Invalid research snapshot.');
  if (
    !prompt ||
    typeof prompt.system !== 'string' ||
    typeof prompt.input !== 'string' ||
    typeof prompt.model !== 'string' ||
    prompt.system.length > 4000 ||
    prompt.input.length > 60000 ||
    prompt.model.length > 200
  )
    throw new ArchiveRefusal('invalid', 'Invalid research prompt snapshot.');
  if (
    constituents.length < 400 ||
    constituents.length > 600 ||
    metadata.constituentCount !== constituents.length
  )
    throw new ArchiveRefusal('invalid', 'Invalid research universe size.');
  const eligible = constituents.filter((item) => item.series === 'EQ').length;
  if (eligible < 1 || metadata.eligibleConstituentCount !== eligible)
    throw new ArchiveRefusal(
      'invalid',
      'Research eligibility must match the captured EQ constituents.',
    );
  if (!TIMESTAMP_RE.test(metadata.fetchedAt ?? '') || !TIMESTAMP_RE.test(metadata.expiresAt ?? ''))
    throw new ArchiveRefusal('invalid', 'Invalid research universe structure.');
  const fetchedAt = Date.parse(metadata.fetchedAt);
  const expiresAt = Date.parse(metadata.expiresAt);
  const now = Date.now();
  if (
    fetchedAt > now + 30_000 ||
    expiresAt <= now ||
    expiresAt <= fetchedAt ||
    expiresAt - fetchedAt > 6 * 60 * 60_000
  )
    throw new ArchiveRefusal(
      'invalid',
      'Research universe must be verified and fresh before analysis starts.',
    );
  return expiresAt;
}

/**
 * The member's saved run for `requestId`, or null. Throws ArchiveRefusal 'forbidden' for inactive
 * members.
 */
export async function findRun({ userId, requestId }) {
  await requireActiveResearchOwner(userId);
  const row = await ResearchRun.findOne({ userId: userId, requestId: requestId }).lean();
  return row ? runJson(row) : null;
}

/**
 * Starts a run once per request ID, storing the inputs and validated, unexpired universe snapshot.
 * A repeat with identical inputs returns the existing run's state (also after a duplicate-key
 * race); different inputs are a 'conflict'.
 */
export async function beginRun({ userId, requestId, inputs, universe }) {
  await requireActiveResearchOwner(userId);
  const existing = await ResearchRun.findOne({
    userId: userId,
    requestId: requestId,
  }).lean();
  const kindOf = (row) => (row.outcome === 'pending' ? 'running' : row.outcome);
  if (existing) {
    if (!isDeepStrictEqual(existing.inputs, inputs))
      throw new ArchiveRefusal('conflict', 'Research request inputs cannot be changed.');
    return { kind: kindOf(existing), run: runJson(existing) };
  }
  const expiresAt = validBeginRequest(inputs, universe);
  let created;
  try {
    created = await ResearchRun.create({
      userId: userId,
      requestId: requestId,
      startedAt: new Date(),
      inputs: inputs,
      universe: universe,
      sequence: await nextSequence('research_runs'),
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const raced = await ResearchRun.findOne({
      userId: userId,
      requestId: requestId,
    }).lean();
    if (!raced || !isDeepStrictEqual(raced.inputs, inputs))
      throw new ArchiveRefusal('conflict', 'Research request inputs cannot be changed.');
    return { kind: kindOf(raced), run: runJson(raced) };
  }
  if (created.startedAt.getTime() >= expiresAt)
    throw new ArchiveRefusal('invalid', 'Research universe expired before analysis could start.');
  return { kind: 'started', run: runJson(created.toObject()) };
}

/**
 * Completes a pending run with its picks and sources, after checking they fit the requested count
 * and the run's EQ universe. Idempotent for an identical completed result; any other final outcome
 * is a 'conflict'.
 */
export async function finishRun({ userId, requestId, result }) {
  await requireActiveResearchOwner(userId);
  const selected = await ResearchRun.findOne({
    userId: userId,
    requestId: requestId,
  }).lean();
  if (!selected)
    throw new ArchiveRefusal('conflict', 'Research must be saved before analysis starts.');
  if (
    selected.outcome === 'completed' &&
    isDeepStrictEqual({ picks: selected.picks, sources: selected.sources }, result)
  )
    return runJson(selected);
  if (selected.outcome !== 'pending')
    throw new ArchiveRefusal('conflict', 'Research outcome is already final.');
  const eligible = new Set(
    selected.universe.constituents
      .filter((constituent) => constituent.series === 'EQ')
      .map((constituent) => constituent.symbol),
  );
  if (
    result.picks.length > selected.inputs.count ||
    result.sources.length > 100 ||
    result.picks.some((pick) => !eligible.has(pick.symbol)) ||
    new Set(result.picks.map((pick) => pick.symbol)).size !== result.picks.length
  )
    throw new ArchiveRefusal('invalid', 'Research outcome does not match its universe.');
  const finished = await ResearchRun.findOneAndUpdate(
    { _id: selected._id, outcome: 'pending' },
    {
      $set: {
        outcome: 'completed',
        picks: result.picks,
        sources: result.sources,
        finishedAt: new Date(Math.max(Date.now(), selected.startedAt.getTime())),
      },
    },
    { new: true },
  ).lean();
  if (!finished) throw new ArchiveRefusal('conflict', 'Research outcome is already final.');
  return runJson(finished);
}

/** Marks a pending run failed. Never touches a run that already finished; always returns null. */
export async function failRun({ userId, requestId }) {
  await requireActiveResearchOwner(userId);
  const selected = await ResearchRun.findOne({
    userId: userId,
    requestId: requestId,
    outcome: 'pending',
  }).lean();
  if (!selected) return null;
  // A finish may have committed before its response was lost. Never downgrade it.
  await ResearchRun.updateOne(
    { _id: selected._id, outcome: 'pending' },
    {
      $set: {
        outcome: 'failed',
        finishedAt: new Date(Math.max(Date.now(), selected.startedAt.getTime())),
      },
    },
  );
  return null;
}

/**
 * One page of the member's runs, newest first, with a cursor to the next page. An unknown or
 * foreign cursor is refused as 'bad-cursor'.
 */
export async function listRunsPage({ userId, beforeId }) {
  await requireActiveResearchOwner(userId);
  let anchor = null;
  if (beforeId) {
    anchor = await ResearchRun.findOne({ userId: userId, _id: beforeId }, { sequence: 1 }).lean();
    // Do not distinguish an absent cursor from another owner's cursor.
    if (!anchor) throw new ArchiveRefusal('bad-cursor', 'Invalid research history cursor.');
  }
  const page = await ResearchRun.find({
    userId: userId,
    ...(anchor ? { sequence: { $lt: anchor.sequence } } : {}),
  })
    .sort({ sequence: -1 })
    .limit(HISTORY_LIMIT + 1)
    .lean();
  const visible = page.slice(0, HISTORY_LIMIT);
  return {
    runs: visible.map(runJson),
    maxRuns: HISTORY_LIMIT,
    nextCursor: page.length > HISTORY_LIMIT ? visible.at(-1)._id : null,
  };
}
