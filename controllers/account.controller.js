/**
 * Account endpoints: signed-in devices, data backup export/restore, email
 * report preferences, the scheduled report jobs and live order settings.
 */
import multer from 'multer';
import { z } from 'zod';
import { SESSION_MAX_AGE_MS } from '../middleware/session.js';
import {
  listUserSessions,
  revokeUserSession,
  revokeUserSessions,
} from '../services/auth/accounts.js';
import { buildBackup, restoreBackup } from '../services/journal/backup.js';
import { AccountSettings } from '../models/index.js';
import { isMailConfigured } from '../services/mailer.js';
import { reserveAttempts } from '../services/rate-window.js';
import * as shareLinks from '../services/journal/share-links.js';
import { hasOpenAiKey } from '../services/ai/openai-key.js';
import { requireMethod } from '../services/http.js';
import { authorizeMaintenance } from '../services/maintenance/authorize.js';
import { runDailyImports as runDailyImportsNow } from '../services/broker/daily-import.js';
import { runPremarketPlans as runPremarketPlansNow } from '../services/ai/premarket-plan.js';
import {
  lastCompletedWeek,
  sendWeeklyReport,
  sendWeeklyReports,
} from '../services/journal/weekly-report.js';
import {
  listLiveOrders,
  liveTradingState,
  placeLiveOrder,
  placeStopTargetGtt,
  setLiveTrading,
} from '../services/broker/live-orders.js';
import { HttpError } from '../services/errors.js';
import { submitProblemReport } from '../services/admin/problem-reports.js';
import { todayInIst } from '../shared/market.js';

const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

/** Backups can exceed the JSON body limit, so they arrive as an uploaded file. */
export const backupFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BACKUP_BYTES, files: 1, fields: 4 },
}).single('file');

/* ------------------------------------ sessions ------------------------------------ */

/** GET /api/account/sessions: the member's signed-in devices, newest activity first; marks this one. */
export async function listSessions(req, res) {
  res.json({
    sessions: await listUserSessions(
      req.member.userId,
      req.member.session.sessionId,
      SESSION_MAX_AGE_MS,
    ),
  });
}

/**
 * POST /api/account/sessions/revoke { sessionId }: signs out one other device.
 * 400 for the current session (use Sign out), 404 when it has already ended.
 */
export async function revokeSession(req, res) {
  const parsed = z.object({ sessionId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) throw new HttpError('Choose a session to sign out.', 400);
  if (parsed.data.sessionId === req.member.session.sessionId) {
    throw new HttpError('Use Sign out to end this session.', 400);
  }
  const removed = await revokeUserSession(req.member.userId, parsed.data.sessionId);
  if (!removed) throw new HttpError('That session has already ended.', 404);
  res.json({ ok: true });
}

/** POST /api/account/sessions/revoke-others: signs out every session except this one. */
export async function revokeOtherSessions(req, res) {
  await revokeUserSessions(req.member.userId, req.sessionID);
  res.json({ ok: true });
}

/* ------------------------------------- backup ------------------------------------- */

/** GET /api/account/export: downloads everything the member owns as one dated JSON backup file. */
export async function exportBackup(req, res) {
  const backup = await buildBackup(req.member.userId, req.member.user.email);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="pirento-blank-backup-${todayInIst()}.json"`,
  );
  res.type('application/json').send(JSON.stringify(backup, null, 2));
}

/**
 * POST /api/account/restore (multipart file, includeSettings?): adds a JSON backup's
 * records to the account and returns a per-section summary. 400 for invalid JSON.
 */
export async function importBackup(req, res) {
  if (!req.file) throw new HttpError('Choose a backup file to restore.', 400);
  let raw;
  try {
    raw = JSON.parse(req.file.buffer.toString('utf8'));
  } catch {
    throw new HttpError('This file is not a valid Pirento Blank backup.', 400);
  }
  const includeSettings = req.body?.includeSettings === 'true';
  res.json({ summary: await restoreBackup(req.member.userId, raw, { includeSettings }) });
}

/* --------------------------------- weekly report email --------------------------------- */

/**
 * GET /api/account/notifications: weekly email, AI coach, daily journal and pre-market plan opt-ins,
 * and whether email and AI are set up.
 */
export async function getNotifications(req, res) {
  const row = await AccountSettings.findById(req.member.userId).lean();
  res.json({
    weeklyReportEmail: Boolean(row?.weeklyReportEmail),
    weeklyAiCoach: Boolean(row?.weeklyAiCoach),
    dailyAutoImport: Boolean(row?.dailyAutoImport),
    premarketPlan: Boolean(row?.premarketPlan),
    // On unless the member turned it off.
    announcementEmails: row?.announcementEmails !== false,
    emailConfigured: isMailConfigured(),
    aiConfigured: hasOpenAiKey(),
  });
}

/**
 * PUT /api/account/notifications { weeklyReportEmail?, weeklyAiCoach?, dailyAutoImport?,
 * premarketPlan? }: saves the report opt-ins. 503 when turning on email or AI the server cannot provide.
 */
export async function saveNotifications(req, res) {
  const parsed = z
    .object({
      weeklyReportEmail: z.boolean().optional(),
      weeklyAiCoach: z.boolean().optional(),
      dailyAutoImport: z.boolean().optional(),
      premarketPlan: z.boolean().optional(),
      announcementEmails: z.boolean().optional(),
    })
    .refine((value) => Object.values(value).some((item) => item !== undefined))
    .safeParse(req.body);
  if (!parsed.success) throw new HttpError('Choose whether to receive weekly reports.', 400);
  if (parsed.data.weeklyReportEmail && !isMailConfigured()) {
    throw new HttpError('Email delivery is not configured on this server.', 503);
  }
  if (parsed.data.weeklyAiCoach && !hasOpenAiKey()) {
    throw new HttpError('AI is not configured on this server.', 503);
  }
  const row = await AccountSettings.findOneAndUpdate(
    { _id: req.member.userId },
    { $set: parsed.data },
    { upsert: true, new: true },
  ).lean();
  res.json({
    weeklyReportEmail: Boolean(row.weeklyReportEmail),
    weeklyAiCoach: Boolean(row.weeklyAiCoach),
    dailyAutoImport: Boolean(row.dailyAutoImport),
    premarketPlan: Boolean(row.premarketPlan),
    announcementEmails: row.announcementEmails !== false,
  });
}

/** Send last week's report to the signed-in member now (does not mark the week as sent). */
export async function sendMyWeeklyReport(req, res) {
  const quota = await reserveAttempts(
    [{ key: `weekly-now:${req.member.userId}`, limit: 5 }],
    60 * 60_000,
  );
  if (!quota.allowed) throw new HttpError('Too many report emails. Try again later.', 429);
  const period = lastCompletedWeek();
  await sendWeeklyReport(req.member.user, period);
  res.json({ ok: true, week: period.start });
}

/** Scheduled: weekly reports for every member who opted in. */
export async function runWeeklyReports(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!requireMethod(req, res, 'POST')) return;
  if (!authorizeMaintenance(req, res)) return;
  res.json(await sendWeeklyReports());
}

/** Scheduled (after the close): today's broker fills into the journal for members who opted in. */
export async function runDailyImports(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!requireMethod(req, res, 'POST')) return;
  if (!authorizeMaintenance(req, res)) return;
  res.json(await runDailyImportsNow());
}

/** Scheduled (before the open): today's pre-market plan on Telegram for members who opted in. */
export async function runPremarketPlans(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!requireMethod(req, res, 'POST')) return;
  if (!authorizeMaintenance(req, res)) return;
  res.json(await runPremarketPlansNow());
}

/* ------------------------------------ live orders ------------------------------------ */

/** GET /api/live-orders: whether live orders are allowed right now (with risk status) and the order log. */
export async function getLiveOrders(req, res) {
  const { user, session } = req.member;
  res.json({
    state: await liveTradingState(user, session),
    orders: await listLiveOrders(user._id),
  });
}

/**
 * PUT /api/account/live-trading { enabled }: the member's live order opt-in; enabling
 * needs live trading on the server and a verified authenticator (403 otherwise).
 */
export async function saveLiveTrading(req, res) {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) throw new HttpError('Choose whether to allow live orders.', 400);
  res.json({
    state: await setLiveTrading(req.member.user, req.member.session, parsed.data.enabled),
  });
}

/**
 * POST /api/live-orders { planId, confirmSymbol, idempotencyKey, autoStopTarget? }: sends a
 * reviewed plan to Zerodha (with autoStopTarget, its stop/target GTT follows once filled).
 * 201 when newly placed, 200 for a replay or any other order status.
 */
export async function createLiveOrder(req, res) {
  const parsed = z
    .object({
      planId: z.string().uuid(),
      confirmSymbol: z.string().max(40),
      idempotencyKey: z.string().uuid(),
      autoStopTarget: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) throw new HttpError('Choose a reviewed plan and confirm its symbol.', 400);
  const order = await placeLiveOrder({
    user: req.member.user,
    session: req.member.session,
    ...parsed.data,
  });
  res.status(order.status === 'placed' ? 201 : 200).json({ order });
}

/** POST /api/live-orders/:id/gtt { confirmSymbol }: stop-loss and target GTT for a filled CNC buy. */
export async function createLiveOrderGtt(req, res) {
  const { user, session } = req.member;
  const order = await placeStopTargetGtt({
    user,
    session,
    orderId: req.params.id,
    confirmSymbol: req.body?.confirmSymbol,
  });
  res.json({ order });
}

/* ------------------------------------ mentor links ------------------------------------ */

/** GET /api/share-links: the member's mentor links (tokens are never returned again). */
export async function listShareLinks(req, res) {
  res.json({ links: await shareLinks.listShareLinks(req.member.userId) });
}

/**
 * POST /api/share-links: creates a mentor share link (201); its token is only visible in
 * this response. 409 when the member already has the maximum of active links.
 */
export async function createShareLink(req, res) {
  res.status(201).json(await shareLinks.createShareLink(req.member.userId, req.body));
}

/** POST /api/share-links/:id/revoke: revokes one of the member's share links (404 when not theirs). */
export async function revokeShareLink(req, res) {
  res.json({ link: await shareLinks.revokeShareLink(req.member.userId, req.params.id) });
}

/** POST /api/account/problem-report { category, message, page? }: tells the administrators. */
export async function reportProblem(req, res) {
  res.status(201).json({ report: await submitProblemReport(req.member.user, req.body) });
}
