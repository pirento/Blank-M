/**
 * Scheduled job endpoint that deletes temporary voice-note uploads older than
 * 24 hours.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { requireMethod } from '../services/http.js';
import { expiredObjects, removeObjects } from '../services/storage.js';
import { isSafeOwnerStoragePath } from '../services/storage-path.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;
const candidateSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  name: z.string().min(1).max(1024),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});

function parseCandidates(data) {
  const candidates = z.array(candidateSchema).max(BATCH_SIZE).parse(data);
  const cutoff = Date.now() - RETENTION_MS;
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
    const cutoff = () => new Date(Date.now() - RETENTION_MS);
    const candidates = parseCandidates(await expiredObjects('voice-notes', cutoff(), BATCH_SIZE));
    if (candidates.length === 0) {
      res.status(200).json({ deleted: 0, batchLimit: BATCH_SIZE, moreMayRemain: false });
      return;
    }
    // Recheck IDs and timestamps to reduce stale-name deletion after lookup.
    // Storage remove is name-based: this does not make the final API call an
    // atomic compare-ID deletion against deliberate delete/reupload path reuse.
    const latest = parseCandidates(await expiredObjects('voice-notes', cutoff(), BATCH_SIZE));
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
    if (names.length === 0) {
      res.status(200).json({ deleted: 0, batchLimit: BATCH_SIZE, moreMayRemain });
      return;
    }
    const removed = await removeObjects('voice-notes', names);
    const deleted = z.array(z.object({ name: z.string() })).parse(removed);
    const deletedNames = new Set(deleted.map((item) => item.name));
    if (
      deleted.length !== names.length ||
      deletedNames.size !== names.length ||
      names.some((name) => !deletedNames.has(name))
    ) {
      throw new Error('Storage removal could not be verified');
    }
    res.status(200).json({
      deleted: deleted.length,
      batchLimit: BATCH_SIZE,
      moreMayRemain,
    });
  } catch {
    // A failed provider response may follow partial removal. Retrying selects
    // remaining expired objects again; never report unverified deletion counts.
    res
      .status(503)
      .json({ error: 'Voice-note cleanup could not be confirmed. Retry maintenance.' });
  }
}
