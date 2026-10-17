/** Same-origin client for the append-only research evidence archive. */
import { z } from 'zod';
import { api } from '../core/api.js';
import { evidenceRecordSchema, reviewSchema } from '../../../shared/strategy-evidence.js';

const evidencePage = z.object({ items: z.array(evidenceRecordSchema), hasMore: z.boolean() });
const reviewPage = z.object({ items: z.array(reviewSchema), hasMore: z.boolean() });

/** Promise of one validated page `{ items, hasMore }` of evidence records; `before` is the paging cursor. */
export async function listStrategyEvidence(before, signal) {
  const query = before ? `?before=${encodeURIComponent(before)}` : '';
  return evidencePage.parse(await api(`/api/strategy-evidence${query}`, { signal }));
}

/** POST a new evidence record (60s timeout); resolves to the validated saved record. */
export async function saveStrategyEvidence({ id, snapshot, evidence }, signal) {
  const result = await api('/api/strategy-evidence', {
    method: 'POST',
    body: { id, snapshot, evidence },
    signal,
    timeout: 60_000,
  });
  return evidenceRecordSchema.parse(result.record);
}

/** Promise of one validated page `{ items, hasMore }` of reviews for an evidence record. */
export async function listStrategyReviews(evidenceId, before, signal) {
  const query = before ? `?before=${encodeURIComponent(before)}` : '';
  return reviewPage.parse(
    await api(`/api/strategy-evidence/${encodeURIComponent(evidenceId)}/reviews${query}`, {
      signal,
    }),
  );
}

/** POST a review decision on an evidence record; resolves to the validated saved review. */
export async function appendStrategyReview({
  id,
  evidenceId,
  decision,
  notes,
  expectedRevision,
  confirmed,
}) {
  const result = await api(`/api/strategy-evidence/${encodeURIComponent(evidenceId)}/reviews`, {
    method: 'POST',
    body: { id, decision, notes, expectedRevision, confirmed },
  });
  return reviewSchema.parse(result.review);
}
