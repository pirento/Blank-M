/**
 * Scheduled job endpoint that deletes temporary uploads: voice notes after 24
 * hours and statements/charts sent to the AI after 7 days (they are only read
 * when the member sends them, and can hold private bank details).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { requireMethod } from '../services/http.js';
import { expiredObjects, removeObjects } from '../services/storage.js';
import { isSafeOwnerStoragePath } from '../services/storage-path.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Bucket → how long its files are kept. */
const RETENTION_MS = { 'voice-notes': DAY_MS, statements: 7 * DAY_MS };
const BATCH_SIZE = 100;
const candidateSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  name: z.string().min(1).max(1024),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});

function parseCandidates(data, retentionMs) {
  const candidates = z.array(candidateSchema).max(BATCH_SIZE).parse(data);
  const cutoff = Date.now() - retentionMs;
  if (
    new Set(candidates.map((item) => item.id)).size !== candidates.length ||
    new Set(candidates.map((item) => item.name)).size !== candidates.length ||
    candidates.some(
      (item) =>
        !isSafeOwnerStoragePath(item.name) ||
        Date.parse(item.created_at) > cutoff ||
        Date.parse(item.updated_at) > cutoff,
    )
  ) {
    throw new Error('Invalid cleanup candidates');
  }
  return candidates;
}

function matchesSecret(received, expected) {
  const hash = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(received), hash(expected));
}

/** Scheduled maintenance only. Storage API removal also removes the object bytes. */
export async function handleVoiceNoteCleanup(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!requireMethod(req, res, 'POST')) return;
  const authorization = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '');
  if (!authorization) {
    res.status(401).json({ error: 'Maintenance authorization is required.' });
    return;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim() !== secret || secret.length < 32) {
    res.status(503).json({ error: 'Maintenance is not configured.' });
    return;
  }
  if (!matchesSecret(authorization[1], secret)) {
    res.status(401).json({ error: 'Maintenance authorization is required.' });
    return;
  }

  try {
    let deleted = 0;
    let moreMayRemain = false;
    for (const [bucketName, retentionMs] of Object.entries(RETENTION_MS)) {
      const batch = await cleanBucket(bucketName, retentionMs);
      deleted += batch.deleted;
      moreMayRemain ||= batch.moreMayRemain;
    }
    res.status(200).json({ deleted, batchLimit: BATCH_SIZE, moreMayRemain });
  } catch {
    // A failed provider response may follow partial removal. Retrying selects
    // remaining expired objects again; never report unverified deletion counts.
    res
      .status(503)
      .json({ error: 'Voice-note cleanup could not be confirmed. Retry maintenance.' });
  }
}

/** Deletes one batch of a bucket's files older than `retentionMs`; returns `{ deleted, moreMayRemain }`. */
async function cleanBucket(bucketName, retentionMs) {
  const cutoff = () => new Date(Date.now() - retentionMs);
  const candidates = parseCandidates(
    await expiredObjects(bucketName, cutoff(), BATCH_SIZE),
    retentionMs,
  );
  if (candidates.length === 0) return { deleted: 0, moreMayRemain: false };
  // Recheck IDs and timestamps to reduce stale-name deletion after lookup.
  // Storage remove is name-based: this does not make the final API call an
  // atomic compare-ID deletion against deliberate delete/reupload path reuse.
  const latest = parseCandidates(
    await expiredObjects(bucketName, cutoff(), BATCH_SIZE),
    retentionMs,
  );
  const names = candidates
    .filter((item) =>
      latest.some(
        (current) =>
          current.id === item.id &&
          current.name === item.name &&
          current.created_at === item.created_at &&
          current.updated_at === item.updated_at,
      ),
    )
    .map((item) => item.name);
  const moreMayRemain = latest.length === BATCH_SIZE || latest.length > names.length;
  if (names.length === 0) return { deleted: 0, moreMayRemain };
  const removed = await removeObjects(bucketName, names);
  const deleted = z.array(z.object({ name: z.string() })).parse(removed);
  const deletedNames = new Set(deleted.map((item) => item.name));
  if (
    deleted.length !== names.length ||
    deletedNames.size !== names.length ||
    names.some((name) => !deletedNames.has(name))
  ) {
    throw new Error('Storage removal could not be verified');
  }
  return { deleted: deleted.length, moreMayRemain };
}
