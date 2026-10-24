/**
 * The daily automatic journal: after the close, for each member who opted in,
 * adds today's Zerodha, Dhan, Upstox, Fyers and Angel One round trips to the journal and sends the day's
 * summary to their Telegram chat. Runs from a scheduled job once per trading
 * day per member; imports are idempotent, so a re-run never duplicates trades.
 */
import { AccountSettings, User } from '../../models/index.js';
import { MARKET_CLOSE_MINUTE, getMarketStatus, toIst } from '../../shared/market.js';
import { accessProblem } from '../auth/accounts.js';
import { hasFeature } from '../billing/membership.js';
import { inBatches } from '../batches.js';
import { HttpError } from '../errors.js';
import { createLogger, errorName } from '../logger.js';
import { activeConnection } from '../market/kite/connection.js';
import { sendToMember, summaryFor } from '../telegram/bot.js';
import { angelStatus } from './angel.js';
import { dhanStatus } from './dhan.js';
import { fyersStatus } from './fyers.js';
import { upstoxStatus } from './upstox.js';
import { importAllFills } from './fills-journal.js';

const log = createLogger('daily-import');
/** Time one batch may spend starting new members (the proxy times out at 180 s). */
const BATCH_BUDGET_MS = 110_000;

const BROKERS = [
  {
    key: 'kite',
    label: 'Zerodha',
    connected: async (userId) => Boolean(await activeConnection(userId)),
  },
  { key: 'dhan', label: 'Dhan', connected: async (userId) => (await dhanStatus(userId)).connected },
  {
    key: 'upstox',
    label: 'Upstox',
    connected: async (userId) => (await upstoxStatus(userId)).connected,
  },
  {
    key: 'fyers',
    label: 'Fyers',
    connected: async (userId) => (await fyersStatus(userId)).connected,
  },
  {
    key: 'angel',
    label: 'Angel One',
    connected: async (userId) => (await angelStatus(userId)).connected,
  },
];

/** Imports today's fills from each connected broker; returns one line per broker. */
async function importForMember(user) {
  const assertAccess = async () => {
    if (await accessProblem(user)) throw new HttpError('Blank access is not active.', 403);
  };
  const lines = [];
  for (const broker of BROKERS) {
    try {
      // Inside the try: one broker whose status cannot be read must not skip the others.
      if (!(await broker.connected(user._id))) continue;
      const result = await importAllFills(user._id, assertAccess, broker.key);
      const open = result.open?.length ? `, ${result.open.length} still open` : '';
      lines.push(`${broker.label}: added ${result.added.length} round trips${open}.`);
    } catch (error) {
      log.warn('daily import failed', { broker: broker.key, error: errorName(error) });
      lines.push(`${broker.label}: could not read today's fills (${error.message ?? 'error'}).`);
    }
  }
  return lines.length
    ? lines
    : ['No broker connected today. Log in to Zerodha in Blank during the day to import fills.'];
}

/**
 * Runs the daily import for every opted-in member not yet done today. Does
 * nothing before the close or on weekends and NSE holidays.
 */
// A batch per call stays well inside the proxy's 180 s timeout (a broker read per member).
export async function runDailyImports({ now = new Date(), limit = 25 } = {}) {
  const status = getMarketStatus(now);
  const ist = toIst(now);
  if (status === 'closed-weekend' || status === 'closed-holiday') {
    return { ran: false, reason: 'not a trading day' };
  }
  if (ist.minutesSinceMidnight <= MARKET_CLOSE_MINUTE) {
    return { ran: false, reason: 'the market has not closed yet' };
  }
  const today = ist.date;
  const due = await AccountSettings.find({
    dailyAutoImport: true,
    dailyAutoImportFor: { $ne: today },
  })
    .limit(limit)
    .lean();
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let outOfTime = false;
  const started = Date.now();
  // Five members at a time: each claim below is atomic, so parallel work never imports twice.
  await inBatches(due, 5, async (settings) => {
    // Slow broker days: stop well before the proxy's 180 s timeout; the next call continues
    // with the members not claimed yet.
    if (Date.now() - started > BATCH_BUDGET_MS) {
      outOfTime = true;
      return;
    }
    // Claim the day first: a member skipped or failing below must not hold a place in every later
    // batch (which would starve everyone after the first `limit` members).
    const claim = await AccountSettings.updateOne(
      { _id: settings._id, dailyAutoImportFor: { $ne: today } },
      { $set: { dailyAutoImportFor: today } },
    );
    if (!claim.modifiedCount) return;
    const user = await User.findById(settings._id);
    // Free members on a billed platform keep the setting but are not imported for.
    if (
      !user ||
      (await accessProblem(user)) ||
      !(await hasFeature(user, 'brokers', { startTrial: false }))
    ) {
      skipped += 1;
      return;
    }
    try {
      const lines = await importForMember(user);
      const summary = await summaryFor(user._id, today, today, `Today (${today})`);
      await sendToMember(user._id, ['Daily journal', ...lines, '', summary].join('\n'));
      done += 1;
    } catch (error) {
      log.warn('daily import run failed', { error: errorName(error) });
      failed += 1;
    }
  });
  return {
    ran: true,
    date: today,
    done,
    skipped,
    failed,
    moreMayRemain: outOfTime || due.length === limit,
  };
}
