/**
 * Free monthly allowance: on a billed platform, a free member may still use a
 * Premium feature a few times a month (the administrator sets how many per
 * feature in the admin panel → Plans & billing). Each API request to the
 * feature uses one; after that the feature needs Premium.
 */
import { UsageCounter } from '../../models/index.js';
import { toIst } from '../../shared/market.js';

/** The IST month, e.g. "2026-10". */
export const currentMonth = (now = new Date()) => toIst(now).date.slice(0, 7);

const counterId = (userId, feature, month) => `${userId}:${feature}:${month}`;

/** First day of the month after next, when a month's counter is no longer needed. */
function expiryOf(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber + 1, 1));
}

/** How many uses of `feature` the member has had this month. */
export async function usedThisMonth(userId, feature, now = new Date()) {
  const row = await UsageCounter.findById(counterId(userId, feature, currentMonth(now))).lean();
  return row?.count ?? 0;
}

/**
 * Uses one of the member's free uses of `feature` this month; false when none are left. Atomic:
 * two requests at once cannot both take the last one.
 */
export async function takeFreeUse(userId, feature, limit, now = new Date()) {
  if (!(limit > 0)) return false;
  const month = currentMonth(now);
  try {
    await UsageCounter.updateOne(
      { _id: counterId(userId, feature, month), count: { $lt: limit } },
      {
        $inc: { count: 1 },
        $setOnInsert: { userId, feature, month, expiresAt: expiryOf(month) },
      },
      { upsert: true },
    );
    return true;
  } catch (error) {
    // The row exists and is at the limit, so the upsert tried to insert a duplicate: none left.
    if (error?.code === 11000) return false;
    throw error;
  }
}

/** `{ feature: { used, limit } }` for every feature with a free allowance (for the billing page). */
export async function freeUsage(userId, freeQuota, now = new Date()) {
  const month = currentMonth(now);
  const rows = await UsageCounter.find({ userId, month }).lean();
  const used = new Map(rows.map((row) => [row.feature, row.count]));
  return Object.fromEntries(
    Object.entries(freeQuota)
      .filter(([, limit]) => limit > 0)
      .map(([feature, limit]) => [feature, { used: used.get(feature) ?? 0, limit }]),
  );
}
