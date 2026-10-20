/**
 * Per-member AI rate limits: counts recent usage and records each request.
 */
import { AiUsageEvent } from '../../models/index.js';
import { HttpError } from '../errors.js';
import { createLogger } from '../logger.js';

const log = createLogger('ai');

const WINDOW_MS = 60 * 60_000;
// An in-flight slot covers a request until its usage event is saved. Requests that fail before
// calling the model never save one, so slots also lapse after the longest possible model call
// (75 s timeout, one retry) instead of blocking the member for the whole hour.
const IN_FLIGHT_MS = 5 * 60_000;
const DEFAULT_LIMIT = 30;
const localWindows = new Map();

/** Whether persisted plus in-flight requests have reached the hourly limit (never below 1). */
export function isRateLimitExceeded(persisted, pending, limit) {
  return persisted + pending >= Math.max(1, limit);
}

/** Persisted usage plus in-flight requests in this process, per rolling hour. */
export async function enforceAiRateLimit(userId) {
  const now = Date.now();
  const since = new Date(now - WINDOW_MS);
  const limit = Math.max(1, Number(process.env.AI_REQUESTS_PER_HOUR || DEFAULT_LIMIT));
  let persisted;
  try {
    persisted = await AiUsageEvent.countDocuments({ userId, createdAt: { $gte: since } });
  } catch {
    throw new HttpError('Could not verify the AI usage limit.', 503);
  }
  const local = (localWindows.get(userId) ?? []).filter((value) => value > now - IN_FLIGHT_MS);
  if (isRateLimitExceeded(Number(persisted ?? 0), local.length, limit)) {
    throw new HttpError('AI request limit reached. Try again after the hourly window resets.', 429);
  }
  local.push(now);
  localWindows.set(userId, local);
}

/**
 * Saves one AI usage event and releases one of this member's in-flight slots. Storage failures are
 * logged, not thrown.
 */
export async function recordAiUsage(input) {
  const local = localWindows.get(input.userId);
  if (local?.length) local.shift();
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
