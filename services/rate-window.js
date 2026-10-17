/**
 * Durable fixed-window rate limits shared by all server processes.
 */
import { RateWindow } from '../models/index.js';

/** Starts a new window for `key` when there is none or the last one has ended. */
async function openWindow(key, windowMs, now) {
  try {
    await RateWindow.updateOne(
      { _id: key, windowStartedAt: { $lte: new Date(now - windowMs) } },
      {
        $set: {
          windowStartedAt: new Date(now),
          attempts: 0,
          expiresAt: new Date(now + windowMs),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    // A live window already exists (the upsert collided with it): use that one.
    if (error?.code !== 11000) throw error;
  }
}

/**
 * Reserve one attempt in every bucket together, or none. Returns the longest
 * remaining wait when any bucket is full. Each reservation is a single atomic
 * conditional increment, so parallel requests cannot overshoot a limit.
 */
export async function reserveAttempts(buckets, windowMs, now = Date.now()) {
  const reserved = [];
  let retryAfterMs = 0;
  for (const bucket of buckets) {
    await openWindow(bucket.key, windowMs, now);
    const row = await RateWindow.findOneAndUpdate(
      { _id: bucket.key, attempts: { $lt: bucket.limit } },
      { $inc: { attempts: 1 } },
      { new: true },
    ).lean();
    if (row) {
      reserved.push(bucket.key);
      continue;
    }
    const full = await RateWindow.findById(bucket.key).lean();
    const endsAt = full ? full.windowStartedAt.getTime() + windowMs : now + windowMs;
    retryAfterMs = Math.max(retryAfterMs, endsAt - now, 1);
  }
  if (retryAfterMs > 0) {
    // All or none: give back what this call took from the other buckets.
    if (reserved.length) {
      await RateWindow.updateMany(
        { _id: { $in: reserved }, attempts: { $gt: 0 } },
        { $inc: { attempts: -1 } },
      );
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}
