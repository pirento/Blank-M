/**
 * Trade chart screenshots: attach, read and remove one per trade, and the daily sweep that deletes
 * files no trade points to any more.
 */
import { Counter, Trade } from '../../models/index.js';
import { HttpError } from '../errors.js';
import { createLogger, errorName } from '../logger.js';
import { expiredObjects, removeObjects, tradeScreenshotPath, uploadObject } from '../storage.js';
import { toTrade } from './mappers.js';

const log = createLogger('journal');

/**
 * Deletes a screenshot file the trade no longer points to. The trade change has already
 * succeeded, so a failure is only logged; the daily orphan sweep removes the file later.
 */
export async function discardScreenshot(path) {
  try {
    await removeObjects('trade-screenshots', [path]);
  } catch (error) {
    log.warn('screenshot delete failed', { error: errorName(error) });
  }
}

/** Screenshot files older than this that no trade points to are left over (see discardScreenshot). */
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
/** Screenshot files checked per maintenance call. */
const SWEEP_BATCH = 1000;
/**
 * Counter holding where the next sweep slice starts: the upload time in GridFS (0: from the oldest
 * file) or, in S3, which lists by name, the last name checked.
 */
const SWEEP_POSITION = 'screenshot_sweep';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** tradeScreenshotPath's `<owner>/<trade>/<uuid>`: anything else in the bucket is not ours to delete. */
const SCREENSHOT_NAME = new RegExp(`^${UUID}/${UUID}/${UUID}$`, 'i');

/**
 * One slice of the orphan sweep: deletes trade-screenshot files older than a day that no trade
 * points to, walking the bucket oldest first (by name in S3) and resuming where the last slice stopped, so each
 * call does bounded work. Returns `{ deleted, moreMayRemain }`.
 */
export async function removeOrphanScreenshots() {
  const position = await Counter.findById(SWEEP_POSITION).lean();
  const files = await expiredObjects(
    'trade-screenshots',
    new Date(Date.now() - ORPHAN_AGE_MS),
    SWEEP_BATCH,
    new Date(position?.value ?? 0),
    position?.after,
  );
  // Only that trade can point to the file. Other objects (a shared S3 bucket) are skipped.
  const names = files.map((file) => file.name).filter((name) => SCREENSHOT_NAME.test(name));
  const tradeIds = names.map((name) => name.split('/')[1]);
  const kept = new Set(
    (await Trade.find({ _id: { $in: tradeIds } }, { screenshotPath: 1 }).lean()).map(
      (trade) => trade.screenshotPath,
    ),
  );
  const orphans = names.filter((name) => !kept.has(name));
  if (orphans.length) await removeObjects('trade-screenshots', orphans);
  // A full slice resumes from its last file (re-checked, harmless); a short one reached the end.
  const moreMayRemain = files.length === SWEEP_BATCH;
  await Counter.updateOne(
    { _id: SWEEP_POSITION },
    {
      $set: {
        value: moreMayRemain ? Date.parse(files.at(-1).created_at) : 0,
        after: moreMayRemain ? files.at(-1).name : '',
      },
    },
    { upsert: true },
  );
  return { deleted: orphans.length, moreMayRemain };
}

/** Attach (or replace) the chart screenshot of one of the member's trades. */
export async function attachTradeScreenshot(userId, id, file) {
  if (!(await Trade.exists({ _id: id, userId }))) {
    throw new HttpError('This trade is no longer available.', 404);
  }
  const path = await uploadObject(
    'trade-screenshots',
    tradeScreenshotPath(userId, id),
    userId,
    file,
  );
  // Read the replaced path from the write itself: with two overlapping uploads,
  // each removes exactly the image it replaced, so none is left behind.
  const previous = await Trade.findOneAndUpdate(
    { _id: id, userId },
    { $set: { screenshotPath: path } },
    { new: false },
  ).lean();
  if (!previous) {
    // The trade was deleted while uploading; do not leave the image behind.
    await discardScreenshot(path);
    throw new HttpError('This trade is no longer available.', 404);
  }
  if (previous.screenshotPath && previous.screenshotPath !== path) {
    await discardScreenshot(previous.screenshotPath);
  }
  return toTrade({ ...previous, screenshotPath: path });
}

/** The stored screenshot path of a member's trade, or null. */
export async function tradeScreenshot(userId, id) {
  const stored = await Trade.findOne({ _id: id, userId }, { screenshotPath: 1 }).lean();
  if (!stored) throw new HttpError('This trade is no longer available.', 404);
  return stored.screenshotPath ?? null;
}

/**
 * Detaches the trade's screenshot and deletes the stored image. Throws HttpError 404 when the trade
 * does not exist.
 */
export async function removeTradeScreenshot(userId, id) {
  const stored = await Trade.findOneAndUpdate(
    { _id: id, userId },
    { $set: { screenshotPath: null } },
  ).lean();
  if (!stored) throw new HttpError('This trade is no longer available.', 404);
  if (stored.screenshotPath) await discardScreenshot(stored.screenshotPath);
  return toTrade({ ...stored, screenshotPath: null });
}
