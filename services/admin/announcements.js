/**
 * Administrator announcements: one email to every active member, or only to
 * Premium or free members. Sent in the background in batches; members who
 * turned announcements off (Settings → Email reports) are skipped.
 */
import { z } from 'zod';
import {
  AccountSettings,
  AdminAuditLog,
  Announcement,
  Subscription,
  User,
} from '../../models/index.js';
import { computeMembership } from '../billing/membership.js';
import { loadPlan } from '../billing/plan.js';
import { HttpError } from '../errors.js';
import { createLogger, errorName } from '../logger.js';
import { isMailConfigured } from '../mailer.js';
import { sendQuietly } from '../notifications/emails.js';

const log = createLogger('announcements');
const BATCH = 100;

const inputSchema = z.object({
  subject: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(10_000),
  audience: z.enum(['all', 'premium', 'free']),
});

const toAnnouncement = (row) => ({
  id: row._id,
  subject: row.subject,
  audience: row.audience,
  status: row.status,
  sent: row.sent,
  skipped: row.skipped,
  failed: row.failed,
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

/** The latest 20 announcements, newest first. */
export async function listAnnouncements() {
  const rows = await Announcement.find().sort({ createdAt: -1 }).limit(20).lean();
  return rows.map(toAnnouncement);
}

const LEASE_MS = 2 * 60_000;

/**
 * Records the announcement, audits it and starts sending in the background. Returns it at once;
 * the admin page shows its progress. Only one announcement can be sending at a time.
 */
export async function startAnnouncement(actor, input) {
  if (!isMailConfigured()) throw new HttpError('Set up email (SMTP) first.', 503);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError('Write a subject (≤150 characters) and a message (≤10,000).', 400);
  }
  let row;
  try {
    row = await Announcement.create({
      ...parsed.data,
      createdBy: actor.id,
      leaseUntil: new Date(Date.now() + LEASE_MS),
    });
  } catch (error) {
    if (error?.code === 11000)
      throw new HttpError('Another announcement is still being sent.', 409);
    throw error;
  }
  await AdminAuditLog.create({
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'announcement.send',
    target: row._id,
    details: { subject: row.subject, audience: row.audience },
  });
  void runSafely(row.toObject());
  return toAnnouncement(row.toObject());
}

/**
 * Picks up an announcement whose sender stopped (a restart or deploy) and finishes it from where
 * it stopped. Called every minute by each web process; the lease makes sure only one sends.
 */
export async function resumeAnnouncements() {
  const now = new Date();
  const row = await Announcement.findOneAndUpdate(
    { status: 'sending', $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] },
    { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) } },
    { new: true },
  ).lean();
  if (row) await runSafely(row);
}

/** Starts the once-a-minute check for stopped announcements; returns a stop function. */
export function startAnnouncementResumer() {
  const timer = setInterval(() => {
    resumeAnnouncements().catch((error) => log.warn('resume failed', { error: errorName(error) }));
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

async function runSafely(row) {
  try {
    await sendAnnouncement(row);
  } catch (error) {
    // The lease lapses and another run (or this process in a minute) continues from lastUserId.
    log.error('announcement paused', { error: errorName(error) });
  }
}

/** Whether a member belongs to the announcement's audience. */
function inAudience(audience, membership) {
  if (audience === 'all') return true;
  return audience === 'premium' ? membership.premium : !membership.premium;
}

async function sendAnnouncement(row) {
  const plan = await loadPlan();
  const origin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : '';
  let lastId = row.lastUserId ?? '';
  for (;;) {
    const users = await User.find(
      { _id: { $gt: lastId }, status: 'active', emailConfirmedAt: { $ne: null } },
      { email: 1, role: 1 },
    )
      .sort({ _id: 1 })
      .limit(BATCH)
      .lean();
    if (!users.length) break;
    const ids = users.map((user) => user._id);
    const [settings, subs] = await Promise.all([
      AccountSettings.find({ _id: { $in: ids } }, { announcementEmails: 1 }).lean(),
      Subscription.find({ _id: { $in: ids } }).lean(),
    ]);
    const optedOut = new Set(
      settings.filter((item) => item.announcementEmails === false).map((item) => item._id),
    );
    const subById = new Map(subs.map((sub) => [sub._id, sub]));
    for (const user of users) {
      const membership = computeMembership(plan, user, subById.get(user._id) ?? null);
      let outcome = 'skipped';
      if (!optedOut.has(user._id) && inAudience(row.audience, membership)) {
        const ok = await sendQuietly(user.email, row.subject, [
          row.body,
          '',
          '—',
          origin
            ? `You get these emails as a Pirento Blank member. Turn them off: ${origin}/settings`
            : 'Turn these emails off in Settings → Email reports.',
        ]);
        outcome = ok ? 'sent' : 'failed';
      }
      lastId = user._id;
      // Saved after every member, so a restart never emails anyone twice; also renews the lease.
      const kept = await Announcement.updateOne(
        { _id: row._id, status: 'sending' },
        {
          $inc: { [outcome]: 1 },
          $set: { lastUserId: lastId, leaseUntil: new Date(Date.now() + LEASE_MS) },
        },
      );
      if (!kept.modifiedCount) return;
    }
  }
  await Announcement.updateOne(
    { _id: row._id },
    { $set: { status: 'done', finishedAt: new Date(), leaseUntil: null } },
  );
}
