/**
 * Free monthly allowance: on a billed platform, a free member may still use a
 * Premium feature a little each month (the administrator sets how much per
 * feature in the admin panel → Plans & billing).
 *
 *   AI       — counted per request that does AI work (POST); reading past results is free.
 *   others   — counted per day of use (IST): the first use of the day takes one, everything
 *              else that day (page loads, refreshes, live-price reconnects) is free.
 */
import { UsageCounter } from '../../models/index.js';
import { toIst } from '../../shared/market.js';

/** Features counted per request; every other feature is counted per day of use. */
export const PER_REQUEST_FEATURES = new Set(['ai']);

/** The IST month, e.g. "2026-10". */
export const currentMonth = (now = new Date()) => toIst(now).date.slice(0, 7);

const monthKey = (userId, feature, month) => `${userId}:${feature}:${month}`;

/** First day of the month after next, when a month's counter is no longer needed. */
function expiryOf(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber + 1, 1));
}

/** How many uses (or days) of `feature` the member has had this month. */
export async function usedThisMonth(userId, feature, now = new Date()) {
  const row = await UsageCounter.findById(monthKey(userId, feature, currentMonth(now))).lean();
  return row?.count ?? 0;
}

/**
 * Takes one of the member's free uses of `feature` this month; false when none are left. Atomic:
 * two requests at once cannot both take the last one.
 */
export async function takeFreeUse(userId, feature, limit, now = new Date()) {
  if (!(limit > 0)) return false;
  const month = currentMonth(now);
  const _id = monthKey(userId, feature, month);
  try {
    await UsageCounter.updateOne(
      { _id, count: { $lt: limit } },
      {
        $inc: { count: 1 },
        $setOnInsert: { userId, feature, month, expiresAt: expiryOf(month) },
      },
      { upsert: true },
    );
    return true;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Either the row is at the limit, or a parallel first use created it: try once without upsert.
    const retry = await UsageCounter.updateOne(
      { _id, count: { $lt: limit } },
      { $inc: { count: 1 } },
    );
    return retry.modifiedCount === 1;
  }
}

/**
 * Per-day features: true when the member already used `feature` today, or one more free day could
 * be taken for today.
 */
export async function takeFreeDay(userId, feature, limit, now = new Date()) {
  if (!(limit > 0)) return false;
  const today = toIst(now).date;
  const dayId = `${userId}:${feature}:day:${today}`;
  try {
    // The day marker is created by the first request of the day only.
    await UsageCounter.create({
      _id: dayId,
      userId,
      feature,
      month: today.slice(0, 7),
      count: 0,
      expiresAt: new Date(now.getTime() + 2 * 24 * 60 * 60_000),
    });
  } catch (error) {
    if (error?.code === 11000) return true; // already counted today
    throw error;
  }
  if (await takeFreeUse(userId, feature, limit, now)) return true;
  await UsageCounter.deleteOne({ _id: dayId });
  return false;
}

/** `{ feature: { used, limit, unit } }` for every feature with a free allowance (billing page). */
export async function freeUsage(userId, freeQuota, now = new Date()) {
  const month = currentMonth(now);
  const rows = await UsageCounter.find({ userId, month }).lean();
  const used = new Map(
    rows.filter((row) => !row._id.includes(':day:')).map((row) => [row.feature, row.count]),
  );
  return Object.fromEntries(
    Object.entries(freeQuota)
      .filter(([, limit]) => limit > 0)
      .map(([feature, limit]) => [
        feature,
        {
          used: used.get(feature) ?? 0,
          limit,
          unit: PER_REQUEST_FEATURES.has(feature) ? 'uses' : 'days',
        },
      ]),
  );
}
