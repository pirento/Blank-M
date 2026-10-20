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
  // A send that stopped (server restart) stops counting as "in progress" after 30 quiet minutes.
  const active = { status: 'sending', updatedAt: { $gt: new Date(Date.now() - 30 * 60_000) } };
  if (await Announcement.exists(active)) {
    throw new HttpError('Another announcement is still being sent.', 409);
  }
  const row = await Announcement.create({ ...parsed.data, createdBy: actor.id });
  await AdminAuditLog.create({
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'announcement.send',
    target: row._id,
    details: { subject: row.subject, audience: row.audience },
  });
  void sendAnnouncement(row).catch(async (error) => {
    log.error('announcement stopped', { error: errorName(error) });
    await Announcement.updateOne(
      { _id: row._id },
      { $set: { status: 'done', finishedAt: new Date() } },
    );
  });
  return toAnnouncement(row.toObject());
}

/** Whether a member belongs to the announcement's audience. */
function inAudience(audience, membership) {
  if (audience === 'all') return true;
  return audience === 'premium' ? membership.premium : !membership.premium;
}

async function sendAnnouncement(row) {
  const plan = await loadPlan();
  const origin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : '';
  let lastId = '';
  for (;;) {
    const users = await User.find(
      { _id: { $gt: lastId }, status: 'active', emailConfirmedAt: { $ne: null } },
      { email: 1, role: 1 },
    )
      .sort({ _id: 1 })
      .limit(BATCH)
      .lean();
    if (!users.length) break;
    lastId = users.at(-1)._id;
    const ids = users.map((user) => user._id);
    const [settings, subs] = await Promise.all([
      AccountSettings.find({ _id: { $in: ids } }, { announcementEmails: 1 }).lean(),
      Subscription.find({ _id: { $in: ids } }).lean(),
    ]);
    const optedOut = new Set(
      settings.filter((s) => s.announcementEmails === false).map((s) => s._id),
    );
    const subById = new Map(subs.map((sub) => [sub._id, sub]));
    const counts = { sent: 0, skipped: 0, failed: 0 };
    for (const user of users) {
      const membership = computeMembership(plan, user, subById.get(user._id) ?? null);
      if (optedOut.has(user._id) || !inAudience(row.audience, membership)) {
        counts.skipped += 1;
        continue;
      }
      const ok = await sendQuietly(user.email, row.subject, [
        row.body,
        '',
        '—',
        origin
          ? `You get these emails as a Pirento Blank member. Turn them off: ${origin}/settings`
          : 'Turn these emails off in Settings → Email reports.',
      ]);
      counts[ok ? 'sent' : 'failed'] += 1;
    }
    await Announcement.updateOne({ _id: row._id }, { $inc: counts });
  }
  await Announcement.updateOne(
    { _id: row._id },
    { $set: { status: 'done', finishedAt: new Date() } },
  );
}
