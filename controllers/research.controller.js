/**
 * GET /api/research/runs: the member's saved research history, one page at a
 * time, kept under the response size limit.
 */
import { researchHistoryCursorSchema } from '../shared/ai-schemas.js';
import { authenticateRequest } from '../services/auth/request-auth.js';
import {
  HISTORY_LIMIT,
  ResearchArchiveError,
  listResearchRuns,
} from '../services/ai/research-archive.js';

const HISTORY_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * GET /api/research/runs?cursor=: a page of { runs, maxRuns, nextCursor }. The page stops early
 * once the JSON would pass 2 MB, and nextCursor resumes right after the last run sent.
 */
export async function handleResearchRuns(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed. Use GET.' });
    return;
  }
  try {
    const { user } = await authenticateRequest(req);
    // Owner and page size are never taken from user-supplied query parameters.
    const rawCursor = req.query?.cursor;
    const cursor = researchHistoryCursorSchema.optional().safeParse(rawCursor);
    if (!cursor.success) throw new ResearchArchiveError('Invalid research history cursor.', 400);
    const page = await listResearchRuns(user.id, cursor.data);
    const { runs } = page;
    // Snapshots and captured prompts can make fifty valid rows exceed the host's
    // response limit. Count the actual UTF-8 JSON envelope, including commas and
    // the continuation cursor; resume after the last emitted row without gaps.
    let emitted = 0;
    let rowBytes = 0;
    for (const run of runs) {
      const count = emitted + 1;
      const nextCursor = count < runs.length ? run.id : page.nextCursor;
      const envelopeBytes = Buffer.byteLength(
        JSON.stringify({ runs: [], maxRuns: HISTORY_LIMIT, nextCursor }),
        'utf8',
      );
      const candidateBytes = rowBytes + Buffer.byteLength(JSON.stringify(run), 'utf8');
      if (envelopeBytes + candidateBytes + count - 1 > HISTORY_RESPONSE_BYTES) break;
      rowBytes = candidateBytes;
      emitted = count;
    }
    if (runs.length && !emitted) throw new ResearchArchiveError();
    res.status(200).json({
      runs: runs.slice(0, emitted),
      maxRuns: HISTORY_LIMIT,
      nextCursor: emitted < runs.length ? runs[emitted - 1].id : page.nextCursor,
    });
  } catch (error) {
    const status =
      error instanceof ResearchArchiveError
        ? error.status
        : error instanceof Error &&
            'status' in error &&
            (error.status === 401 || error.status === 403)
          ? error.status
          : 503;
    res.status(status).json({
      error:
        error instanceof ResearchArchiveError
          ? error.message
          : status === 401
            ? 'Sign in to view saved research.'
            : status === 403
              ? 'This account no longer has access to saved research.'
              : 'Saved research is unavailable. Please try again later.',
    });
  }
}
