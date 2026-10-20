/**
 * The admin panel (/admin): its pages and the JSON endpoints those pages call —
 * overview numbers, integration settings (API keys), the Premium plan,
 * payments, member subscriptions and the audit log.
 *
 * Every route here sits behind requireAdminPage / requireApiAdmin
 * (routes/admin.js, routes/api.js); changes to keys, money or access also need
 * requireAdminMfa. Member management itself (invites, revoke, reset links) keeps
 * its existing endpoints in admin.controller.js.
 */
import fs from 'node:fs/promises';
import { z } from 'zod';
import { AdminAuditLog, Trade, User } from '../models/index.js';
import { isDatabaseConnected, nativeDb } from '../config/database.js';
import { HttpError } from '../services/errors.js';
import { hasOpenAiKey } from '../services/ai/openai-key.js';
import { isMailConfigured } from '../services/mailer.js';
import { isKiteConfigured } from '../services/market/index.js';
import { isTelegramConfigured } from '../services/telegram/api.js';
import { isPushConfigured } from '../services/notifications/push.js';
import { checkKeys, isRazorpayConfigured } from '../services/billing/razorpay.js';
import { PREMIUM_FEATURES, loadPlan, publicPlan, savePlan } from '../services/billing/plan.js';
import {
  billingMetrics,
  grantPremium,
  membershipsByUser,
  recentPayments,
} from '../services/billing/subscriptions.js';
import { describePlatformSettings, savePlatformSettings } from '../services/platform/settings.js';
import { env } from '../config/env.js';
import { listAnnouncements, startAnnouncement } from '../services/admin/announcements.js';

const DAY_MS = 24 * 60 * 60_000;
const actorOf = (req) => ({ id: req.member.userId, email: req.member.user.email });

/* ------------------------------------- pages ------------------------------------- */

/** GET /admin/login: the administrator sign-in page (signed-in admins go straight in). */
export function loginPage(req, res) {
  const { user, mfaRequired, accessError } = req.auth;
  if (user && !accessError && !mfaRequired && user.role === 'admin') return res.redirect('/admin');
  const errors = {
    google:
      'Google sign-in could not be completed, or that Google account is not an administrator.',
    google_unavailable: 'Google sign-in is not set up (admin panel → Integrations).',
    invite_only: 'That Google account is not an administrator.',
  };
  res.render('admin/login', {
    title: 'Admin sign-in',
    googleEnabled: env.googleAuthEnabled,
    initialError: errors[req.query.error] ?? null,
  });
}

/** The data every admin page embeds for its browser module. */
function adminPageData(req, extra = {}) {
  return {
    accountId: req.member.userId,
    sessionId: req.member.session.sessionId,
    email: req.member.user.email,
    role: 'admin',
    mfaVerified: Boolean(req.member.user.hasVerifiedFactor() && req.member.session.aal === 'aal2'),
    // Members page: email invitations are offered only when email delivery works.
    health: { email: isMailConfigured() },
    ...extra,
  };
}

/** Admin pages: [path, view, title, subtitle]. */
export const ADMIN_PAGES = [
  ['/', 'dashboard', 'Overview', 'Members, revenue and the health of the platform.'],
  ['/members', 'members', 'Members', 'Invite members, manage access and Premium.'],
  ['/billing', 'billing', 'Plans & billing', 'Your Premium plan, free trial and payments.'],
  [
    '/integrations',
    'integrations',
    'Integrations',
    'API keys and switches for the whole platform.',
  ],
  ['/ai', 'ai', 'AI models', 'Which OpenAI models the platform uses.'],
  [
    '/announcements',
    'announcements',
    'Announcements',
    'Email all members, or only Premium or free.',
  ],
  ['/audit', 'audit', 'Audit log', 'Every change made in the admin panel.'],
];

/** Renders one admin page view with its browser module. */
export function adminPage(view, title, subtitle) {
  return (req, res) =>
    res.renderAdmin(`admin/${view}`, {
      title,
      subtitle,
      script: view,
      pageData: adminPageData(req),
    });
}

/* ------------------------------------ overview ------------------------------------ */

async function diskFree() {
  try {
    const stats = await fs.statfs('/');
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}

async function lastBackupAt() {
  try {
    return (await fs.stat('backups/.last-ok')).mtime.toISOString();
  } catch {
    return null;
  }
}

/** GET /api/admin/overview: members, Premium, revenue, integrations and system health. */
export async function overview(_req, res) {
  const now = Date.now();
  const since = (days) => new Date(now - days * DAY_MS);
  const [members, active, pending, new7, new30, trades, billing, plan, disk, backup] =
    await Promise.all([
      User.countDocuments(),
      User.countDocuments({ status: 'active', emailConfirmedAt: { $ne: null } }),
      User.countDocuments({ emailConfirmedAt: null }),
      User.countDocuments({ createdAt: { $gt: since(7) } }),
      User.countDocuments({ createdAt: { $gt: since(30) } }),
      Trade.estimatedDocumentCount(),
      billingMetrics(now),
      loadPlan(),
      diskFree(),
      lastBackupAt(),
    ]);
  let database = null;
  if (isDatabaseConnected()) {
    const stats = await nativeDb().stats();
    database = {
      collections: stats.collections,
      dataBytes: stats.dataSize,
      storageBytes: stats.storageSize,
      indexBytes: stats.indexSize,
    };
  }
  res.json({
    members: { total: members, active, pendingActivation: pending, new7d: new7, new30d: new30 },
    trades,
    billing: { ...billing, plan: publicPlan(plan) },
    integrations: {
      openai: hasOpenAiKey(),
      zerodha: isKiteConfigured(),
      email: isMailConfigured(),
      telegram: isTelegramConfigured(),
      push: isPushConfigured(),
      razorpay: isRazorpayConfigured(),
      liveOrders: process.env.LIVE_TRADING_ENABLED === 'true',
      appUrl: env.appUrl || null,
    },
    system: {
      database,
      disk,
      lastBackupAt: backup,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      node: process.version,
    },
  });
}

/* ---------------------------------- integrations ---------------------------------- */

/** GET /api/admin/settings: every editable setting with its source (secrets masked). */
export async function getSettings(_req, res) {
  res.json({ groups: await describePlatformSettings() });
}

/** PUT /api/admin/settings { changes: { KEY: value | "" } }: saves and applies settings. */
export async function saveSettings(req, res) {
  const changes = req.body?.changes;
  res.json({ groups: await savePlatformSettings(actorOf(req), changes) });
}

/* ------------------------------------- billing ------------------------------------- */

/** GET /api/admin/billing: the plan, the feature list and whether Razorpay is set up. */
export async function getBilling(_req, res) {
  const plan = await loadPlan();
  res.json({
    plan: {
      ...publicPlan(plan),
      features: plan.features,
      razorpayPlanId: plan.razorpayPlanId,
    },
    allFeatures: PREMIUM_FEATURES,
    razorpayConfigured: isRazorpayConfigured(),
    webhookUrl: env.appUrl ? `${new URL(env.appUrl).origin}/api/billing/razorpay/webhook` : null,
  });
}

/**
 * POST /api/admin/billing/check-keys: asks Razorpay whether the saved keys work (a read-only
 * call), so a typo shows up here instead of at a member's checkout.
 */
export async function checkRazorpayKeys(_req, res) {
  if (!isRazorpayConfigured())
    throw new HttpError('Add the Razorpay key id and secret first.', 409);
  const { mode } = await checkKeys();
  res.json({
    ok: true,
    mode,
    webhookSecretSet: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET?.trim()),
  });
}

const planSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().max(40).optional(),
    priceMonthly: z.number().optional(),
    trialDays: z.number().optional(),
    features: z.array(z.string()).max(20).optional(),
    freeQuota: z.record(z.number()).optional(),
    signupOpen: z.boolean().optional(),
  })
  .strict();

/** PUT /api/admin/billing { …plan changes }: saves the Premium plan. */
export async function saveBilling(req, res) {
  const parsed = planSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError('Send valid plan settings.', 400);
  // Without the webhook secret renewals never arrive and paying members drop to free.
  if (
    parsed.data.enabled &&
    (!isRazorpayConfigured() || !process.env.RAZORPAY_WEBHOOK_SECRET?.trim())
  ) {
    throw new HttpError(
      'Add the Razorpay key id, key secret and webhook secret in Integrations before switching billing on.',
      409,
    );
  }
  const plan = await savePlan(actorOf(req), parsed.data);
  res.json({ plan: { ...publicPlan(plan), features: plan.features } });
}

/** GET /api/admin/payments: the latest payments across all members. */
export async function listPayments(_req, res) {
  res.json({ payments: await recentPayments() });
}

/** GET /api/admin/memberships: Premium state of every member (for the members table). */
export async function listMemberships(_req, res) {
  // shortcut: one response for every member (~50 bytes each, ~1 MB at 20k); page it past ~50k.
  const users = await User.find({}, { email: 1, role: 1 }).limit(50_000).lean();
  const memberships = await membershipsByUser(users);
  res.json({
    memberships: users.map((user) => ({
      userId: user._id,
      email: user.email,
      ...memberships[user._id],
    })),
  });
}

/** POST /api/admin/members/:userId/premium { days }: grants (or ends, days 0) Premium by hand. */
export async function grantMemberPremium(req, res) {
  const days = Number(req.body?.days);
  res.json({ membership: await grantPremium(actorOf(req), req.params.userId, days) });
}

/* ---------------------------------------- audit ---------------------------------------- */

/** GET /api/admin/audit?before=ISO: 100 audit entries, newest first. */
export async function listAudit(req, res) {
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const filter = before && Number.isFinite(before.getTime()) ? { createdAt: { $lt: before } } : {};
  const rows = await AdminAuditLog.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  res.json({
    entries: rows.map((row) => ({
      id: row._id,
      actorEmail: row.actorEmail,
      action: row.action,
      target: row.target,
      details: row.details,
      createdAt: row.createdAt.toISOString(),
    })),
  });
}

/** GET /api/admin/announcements: the latest announcements and their progress. */
export async function listAnnouncementsHandler(_req, res) {
  res.json({ announcements: await listAnnouncements() });
}

/** POST /api/admin/announcements { subject, body, audience }: starts sending (202). */
export async function sendAnnouncementHandler(req, res) {
  res.status(202).json({ announcement: await startAnnouncement(actorOf(req), req.body ?? {}) });
}
