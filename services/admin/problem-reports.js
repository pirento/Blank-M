/**
 * Member problem reports: a member describes a problem, the administrators are emailed, and an
 * administrator marks it fixed with a note that is emailed back to the member.
 */
import { z } from 'zod';
import { AdminAuditLog, ProblemReport, User } from '../../models/index.js';
import { PROBLEM_CATEGORIES } from '../../models/ProblemReport.js';
import { HttpError } from '../errors.js';
import { reserveAttempts } from '../rate-window.js';
import { sendQuietly } from '../notifications/emails.js';
import { quote } from '../notifications/email-layout.js';

const KEEP_FIXED_MS = 180 * 24 * 60 * 60_000;
const CATEGORY_LABELS = {
  bug: 'Something is broken',
  billing: 'Payment or Premium',
  account: 'Sign-in or account',
  data: 'Wrong numbers or data',
  other: 'Something else',
};

const reportSchema = z.object({
  category: z.enum(PROBLEM_CATEGORIES),
  message: z.string().trim().min(10, 'Describe the problem in a sentence or two.').max(2000),
  page: z.string().trim().max(200).default(''),
});
const resolveSchema = z.object({ note: z.string().trim().max(1000).default('') });

const origin = () => {
  try {
    return new URL(process.env.APP_URL || '').origin;
  } catch {
    return '';
  }
};

function toReport(row) {
  return {
    id: row._id,
    email: row.email,
    category: row.category,
    categoryLabel: CATEGORY_LABELS[row.category],
    message: row.message,
    page: row.page,
    status: row.status,
    adminNote: row.adminNote,
    createdAt: row.createdAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

/** Saves a member's report (at most 5 an hour) and tells the administrators. */
export async function submitProblemReport(user, input) {
  const parsed = reportSchema.safeParse(input ?? {});
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 400);
  const quota = await reserveAttempts([{ key: `problem:${user._id}`, limit: 5 }], 60 * 60_000);
  if (!quota.allowed) throw new HttpError('Too many reports. Try again in an hour.', 429);
  const report = await ProblemReport.create({
    userId: user._id,
    email: user.email,
    ...parsed.data,
  });
  const admins = await User.find({ role: 'admin', status: 'active' }, { email: 1 }).lean();
  await Promise.all(
    admins.map((admin) =>
      sendQuietly(admin.email, `Problem report: ${CATEGORY_LABELS[report.category]}`, [
        `${report.email} reported a problem${report.page ? ` on ${report.page}` : ''}:`,
        '',
        quote(report.message),
        '',
        origin() ? `Open the admin overview: ${origin()}/admin` : null,
      ]),
    ),
  );
  return toReport(report.toObject());
}

/** Open reports first (oldest first), then the latest fixed ones. */
export async function listProblemReports() {
  const [open, fixed] = await Promise.all([
    ProblemReport.find({ status: 'open' }).sort({ createdAt: 1 }).limit(200).lean(),
    ProblemReport.find({ status: 'fixed' }).sort({ resolvedAt: -1 }).limit(30).lean(),
  ]);
  return [...open, ...fixed].map(toReport);
}

/** Marks an open report fixed, logs it and emails the member the administrator's note. */
export async function resolveProblemReport(id, input, actor) {
  const { note } = resolveSchema.parse(input ?? {});
  const now = new Date();
  const report = await ProblemReport.findOneAndUpdate(
    { _id: String(id), status: 'open' },
    {
      $set: {
        status: 'fixed',
        adminNote: note,
        resolvedAt: now,
        purgeAt: new Date(now.getTime() + KEEP_FIXED_MS),
      },
    },
    { new: true },
  ).lean();
  if (!report) throw new HttpError('This report is already fixed or no longer exists.', 404);
  await AdminAuditLog.create({
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'problem-report.fix',
    target: report.email,
  });
  await sendQuietly(report.email, 'Your problem report has been resolved', [
    'Thank you for telling us about a problem with Pirento Blank. Our team has looked into it and marked it resolved.',
    note ? `\nWhat we did:\n${quote(note)}` : null,
    '',
    'Your report:',
    quote(`${report.message.slice(0, 300)}${report.message.length > 300 ? '…' : ''}`),
    '',
    'If it still happens, reply to this email or send a new report from Settings.',
  ]);
  return toReport(report);
}
