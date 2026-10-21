/**
 * Per-member AI rate limits: counts recent usage and records each request.
 */
import { AiUsageEvent } from '../../models/index.js';
import { HttpError } from '../errors.js';
import { reserveAttempts } from '../rate-window.js';
import { createLogger } from '../logger.js';

const log = createLogger('ai');

const WINDOW_MS = 60 * 60_000;
const DEFAULT_LIMIT = 30;

/** Whether persisted plus in-flight requests have reached the hourly limit (never below 1). */
export function isRateLimitExceeded(persisted, pending, limit) {
  return persisted + pending >= Math.max(1, limit);
}

/**
 * The member's hourly AI limit: saved usage in the last rolling hour, plus a reservation in a
 * window shared by every server process (MongoDB), so a burst of parallel requests spread over
 * several processes cannot run past the limit before their usage is saved.
 */
export async function enforceAiRateLimit(userId) {
  const limit = Math.max(1, Number(process.env.AI_REQUESTS_PER_HOUR || DEFAULT_LIMIT));
  let persisted;
  try {
    persisted = await AiUsageEvent.countDocuments({
      userId,
      createdAt: { $gte: new Date(Date.now() - WINDOW_MS) },
    });
  } catch {
    throw new HttpError('Could not verify the AI usage limit.', 503);
  }
  const exceeded = () =>
    new HttpError('AI request limit reached. Try again after the hourly window resets.', 429);
  if (isRateLimitExceeded(Number(persisted ?? 0), 0, limit)) throw exceeded();
  const slot = await reserveAttempts([{ key: `ai-hour:${userId}`, limit }], WINDOW_MS);
  if (!slot.allowed) throw exceeded();
}

/**
 * Saves one AI usage event. Storage failures are logged, not thrown.
 */
export async function recordAiUsage(input) {
  try {
    await AiUsageEvent.create({
      userId: input.userId,
      feature: input.feature,
      model: input.model,
      status: input.status,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      requestId: input.requestId ?? null,
    });
  } catch {
    log.warn('usage record failed');
  }
}
