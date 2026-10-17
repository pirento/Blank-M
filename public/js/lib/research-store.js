/**
 * Browser archive of AI research runs for one member, merged with the cloud
 * history.
 */
import { z } from 'zod';
import {
  citationSchema,
  pickedStockSchema,
  researchUniverseMetadataSchema,
  researchAnalysisReceiptSchema,
} from '../../../shared/ai-schemas.js';

const MAX_RUNS = 20;
const MAX_BYTES = 2_000_000;
const outcomeSchema = z.enum(['pending', 'completed', 'failed', 'cancelled', 'interrupted']);
const snapshotSchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strategies: z.array(z.object({ id: z.string(), name: z.string(), rules: z.string() })),
  rules: z.array(
    z.object({ id: z.string(), section: z.string(), definition: z.string(), rule: z.string() }),
  ),
  openingBalance: z.number().finite(),
  journalBalance: z.number().finite(),
  requestedCandidates: z.literal(10),
});
const runSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  outcome: outcomeSchema,
  inputs: snapshotSchema,
  picks: z.array(pickedStockSchema).max(10),
  sources: z.array(citationSchema),
  universe: researchUniverseMetadataSchema.optional(),
  analysis: researchAnalysisReceiptSchema.optional(),
});
const archiveSchema = z.object({
  version: z.literal(1),
  ownerId: z.string().min(1),
  runs: z.array(runSchema).max(MAX_RUNS),
});

/** A history read can precede the completion receipt returned by the same request. */
export function localCompletionSupersedesPending(local, cloud) {
  return Boolean(
    local?.outcome === 'completed' &&
    cloud?.outcome === 'pending' &&
    local.ownerId === cloud.ownerId &&
    local.id === cloud.requestId &&
    local.analysis?.requestId === cloud.requestId &&
    local.analysis.id === cloud.id &&
    local.universe?.version === cloud.universe.metadata.version,
  );
}

/** The localStorage key for one member's research archive. */
export function researchStorageKey(ownerId) {
  return `blank_research:v1:${encodeURIComponent(ownerId)}`;
}

/** Browser-local request history, never an approved universe or research-session ledger. */
export function readResearchArchive(ownerId) {
  try {
    const raw = window.localStorage.getItem(researchStorageKey(ownerId));
    if (raw === null) return { runs: [], readable: true };
    if (raw.length > MAX_BYTES) return { runs: [], readable: false };
    const parsed = archiveSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.ownerId !== ownerId ||
      parsed.data.runs.some((run) => run.ownerId !== ownerId)
    ) {
      return { runs: [], readable: false };
    }
    return {
      readable: true,
      // A pending request may still run in another tab. Preserve its unknown outcome.
      runs: parsed.data.runs,
    };
  } catch {
    return { runs: [], readable: false };
  }
}

/** Merge the owner's latest browser data; never overwrite unreadable or wrong-owner bytes. */
export function saveResearchRun(ownerId, run) {
  const parsed = runSchema.safeParse(run);
  if (!ownerId || run.ownerId !== ownerId || !parsed.success) return false;
  const existing = readResearchArchive(ownerId);
  if (!existing.readable) return false;
  const runs = [parsed.data, ...existing.runs.filter((item) => item.id !== run.id)].slice(
    0,
    MAX_RUNS,
  );
  try {
    const raw = JSON.stringify({ version: 1, ownerId, runs });
    if (raw.length > MAX_BYTES) return false;
    window.localStorage.setItem(researchStorageKey(ownerId), raw);
    return true;
  } catch {
    return false;
  }
}

/** Citations with valid http(s) URLs and no embedded credentials, de-duplicated by URL. */
export function researchCitations(citations) {
  const seen = new Set();
  return citations.filter((citation) => {
    try {
      const url = new URL(citation.url);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        seen.has(url.href)
      )
        return false;
      seen.add(url.href);
      return true;
    } catch {
      return false;
    }
  });
}
