/**
 * Dhan endpoints: connect with a personal access token, status, disconnect,
 * and today's fills previewed and added to the journal.
 */
import { connectDhan, dhanStatus, disconnectDhan } from '../services/broker/dhan.js';
import { importFills, previewFills } from '../services/broker/fills-journal.js';
import { HttpError } from '../services/errors.js';
import { reserveAttempts } from '../services/rate-window.js';

const noRecheck = async () => undefined;

/** GET /api/dhan: the member's Dhan connection status. */
export async function status(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await dhanStatus(req.member.userId));
}

/** POST /api/dhan/connect: verifies and stores a Dhan access token. Limited to 10 attempts an hour. */
export async function connect(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const quota = await reserveAttempts(
    [{ key: `dhan-connect:${req.member.userId}`, limit: 10 }],
    60 * 60_000,
  );
  if (!quota.allowed) throw new HttpError('Too many connection attempts. Try again later.', 429);
  res.json(await connectDhan(req.member.userId, req.body));
}

/** POST /api/dhan/disconnect: forgets the Dhan token and account binding. */
export async function disconnect(req, res) {
  res.json(await disconnectDhan(req.member.userId));
}

async function fillsQuota(userId) {
  const quota = await reserveAttempts([{ key: `dhan-fills:${userId}`, limit: 30 }], 10 * 60_000);
  if (!quota.allowed) throw new HttpError('Too many Dhan reads. Wait a few minutes.', 429);
}

/** GET /api/dhan/fills: today's Dhan fills paired into round trips, not yet saved. */
export async function fills(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  await fillsQuota(req.member.userId);
  res.json(await previewFills(req.member.userId, noRecheck, 'dhan'));
}

/** POST /api/dhan/fills/import { ids }: adds the chosen round trips to the journal. */
export async function importToJournal(req, res) {
  await fillsQuota(req.member.userId);
  res.json(await importFills(req.member.userId, noRecheck, req.body?.ids, 'dhan'));
}
