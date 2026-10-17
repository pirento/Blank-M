/**
 * Saved research runs: validation around the archive store. A request ID runs
 * the AI research at most once; retries read the saved run, and every run read
 * back is re-verified against its universe snapshot before it is returned.
 */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  citationSchema,
  durableResearchRunSchema,
  pickedStockSchema,
  researchHistoryCursorSchema,
  researchHistoryResponseSchema,
  researchRunInputsSchema,
  researchUniverseSnapshotSchema,
} from '../../shared/ai-schemas.js';

export { HISTORY_LIMIT } from './research-archive-store.js';
import {
  ArchiveRefusal,
  HISTORY_LIMIT,
  beginRun,
  failRun,
  findRun,
  finishRun,
  listRunsPage,
} from './research-archive-store.js';
import { researchUniverseVersion } from './research-universe.js';

const requestIdSchema = z.string().uuid();
const resultSchema = z.object({
  picks: z.array(pickedStockSchema).max(10),
  sources: z.array(citationSchema).max(100),
});

export class ResearchArchiveError extends Error {
  constructor(
    message = 'Saved research is unavailable. Verify the server database configuration before starting another analysis.',
    status = 503,
  ) {
    super(message);
    this.status = status;
    this.name = 'ResearchArchiveError';
  }
}

/** Run one store operation and map its refusals to user-facing errors. */
async function guarded(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ResearchArchiveError) throw error;
    if (error instanceof ArchiveRefusal) {
      if (error.code === 'forbidden') {
        throw new ResearchArchiveError('This account no longer has access to saved research.', 403);
      }
      if (error.code === 'conflict') {
        throw new ResearchArchiveError(
          'This research request already exists with different inputs or a final outcome.',
          409,
        );
      }
      if (error.code === 'bad-cursor') {
        throw new ResearchArchiveError(
          'Invalid research history cursor. Refresh saved research.',
          400,
        );
      }
    }
    // Database diagnostics can contain private data. Never return them to the browser.
    throw new ResearchArchiveError();
  }
}

function verifySnapshot(snapshot, allowLegacy = false) {
  const total = snapshot.constituents.length;
  const eligible = new Set(
    snapshot.constituents.filter((item) => item.series === 'EQ').map((item) => item.symbol),
  );
  const declaredEligible =
    snapshot.metadata.eligibleConstituentCount ??
    (allowLegacy && total === 500 && eligible.size === 500 ? 500 : undefined);
  if (
    total < 400 ||
    total > 600 ||
    snapshot.metadata.constituentCount !== total ||
    new Set(snapshot.constituents.map((item) => item.symbol)).size !== total ||
    new Set(snapshot.constituents.map((item) => item.isin)).size !== total ||
    eligible.size < 1 ||
    declaredEligible !== eligible.size ||
    researchUniverseVersion(snapshot.constituents) !== snapshot.metadata.version
  )
    throw new ResearchArchiveError('The research universe snapshot could not be verified.');
  return eligible;
}

function parseRun(value, ownerId) {
  const parsed = durableResearchRunSchema.safeParse(value);
  if (!parsed.success || parsed.data.ownerId !== ownerId) throw new ResearchArchiveError();
  const run = parsed.data;
  const finished = run.finishedAt !== null;
  const eligibleSymbols = verifySnapshot(run.universe, true);
  if (
    finished !== (run.outcome !== 'pending') ||
    (finished && Date.parse(run.finishedAt) < Date.parse(run.startedAt)) ||
    (run.outcome !== 'completed' && (run.picks.length !== 0 || run.sources.length !== 0)) ||
    run.picks.length > run.inputs.count ||
    new Set(run.picks.map((pick) => pick.symbol)).size !== run.picks.length ||
    run.picks.some((pick) => !eligibleSymbols.has(pick.symbol))
  )
    throw new ResearchArchiveError();
  return run;
}

function assertRequest(run, requestId, inputs) {
  if (run.requestId !== requestId) throw new ResearchArchiveError();
  if (
    inputs &&
    (run.inputs.strategies !== inputs.strategies ||
      run.inputs.rules !== inputs.rules ||
      run.inputs.count !== inputs.count)
  ) {
    throw new ResearchArchiveError('Use a new request ID when changing research inputs.', 409);
  }
}

/** Look up retries before loading today's universe; completed requests retain their original snapshot. */
export async function getResearchRun(userId, requestId, inputs) {
  requestIdSchema.parse(requestId);
  const parsedInputs = researchRunInputsSchema.parse(inputs);
  const value = await guarded(() => findRun({ userId, requestId }));
  if (value === null) return null;
  const run = parseRun(value, userId);
  assertRequest(run, requestId, parsedInputs);
  return run;
}

/** Only the caller receiving `started` owns the provider request; every retry is read-only. */
export async function beginResearchRun(userId, requestId, inputs, universe) {
  requestIdSchema.parse(requestId);
  const parsedInputs = researchRunInputsSchema.parse(inputs);
  const snapshot = researchUniverseSnapshotSchema.parse(universe);
  verifySnapshot(snapshot);
  if (!parsedInputs.prompt)
    throw new ResearchArchiveError('Research prompt must be captured before analysis starts.', 400);
  const value = await guarded(() =>
    beginRun({ userId, requestId, inputs: parsedInputs, universe: snapshot }),
  );
  const parsed = z
    .object({ kind: z.enum(['started', 'running', 'completed', 'failed']), run: z.unknown() })
    .safeParse(value);
  if (!parsed.success) throw new ResearchArchiveError();
  const run = parseRun(parsed.data.run, userId);
  assertRequest(run, requestId, parsedInputs);
  const expectedOutcome =
    parsed.data.kind === 'started' || parsed.data.kind === 'running' ? 'pending' : parsed.data.kind;
  if (run.outcome !== expectedOutcome) throw new ResearchArchiveError();
  if (
    parsed.data.kind === 'started' &&
    (!isDeepStrictEqual(run.inputs, parsedInputs) || !isDeepStrictEqual(run.universe, snapshot))
  )
    throw new ResearchArchiveError();
  return { kind: parsed.data.kind, run };
}

/** A finalization failure never authorizes another provider request for this request ID. */
export async function finishResearchRun(userId, requestId, result) {
  requestIdSchema.parse(requestId);
  const parsedResult = resultSchema.parse(result);
  const value = await guarded(() => finishRun({ userId, requestId, result: parsedResult }));
  const run = parseRun(value, userId);
  assertRequest(run, requestId);
  if (run.outcome !== 'completed') throw new ResearchArchiveError();
  if (!isDeepStrictEqual({ picks: run.picks, sources: run.sources }, parsedResult))
    throw new ResearchArchiveError();
  return run;
}

/** Best effort only: unknown persistence stays pending and cannot trigger an automatic second run. */
export async function failResearchRun(userId, requestId) {
  if (!requestIdSchema.safeParse(requestId).success) return;
  try {
    await guarded(() => failRun({ userId, requestId }));
  } catch {
    // Keep the original provider/finalization failure. A later history read resolves the outcome.
  }
}

/**
 * One verified page of the member's saved research, newest first. `cursor` is
 * the last run ID of the previous page (already validated by the caller).
 */
export async function listResearchRuns(userId, cursor) {
  const value = await guarded(() => listRunsPage({ userId, beforeId: cursor ?? null }));
  const page = researchHistoryResponseSchema
    .extend({
      nextCursor: researchHistoryCursorSchema.nullable(),
    })
    .safeParse(value);
  if (!page.success) throw new ResearchArchiveError();
  const runs = page.data.runs.map((item) => parseRun(item, userId));
  if (new Set(runs.map((run) => run.requestId)).size !== runs.length)
    throw new ResearchArchiveError();
  if (new Set(runs.map((run) => run.id)).size !== runs.length) throw new ResearchArchiveError();
  if (runs.some((run) => run.id === cursor)) throw new ResearchArchiveError();
  if (
    page.data.nextCursor !== null &&
    (runs.length !== HISTORY_LIMIT || page.data.nextCursor !== runs.at(-1)?.id)
  )
    throw new ResearchArchiveError();
  return { runs, nextCursor: page.data.nextCursor };
}
