/**
 * Access requests from the home page form: a visitor asks to join, administrators are told, and
 * an administrator approves (the visitor is invited and gets their sign-in details by email) or
 * rejects it. The visitor always gets the same answer, so the form cannot be used to find out
 * who already has an account.
 */
import { z } from 'zod';
import { AccessRequest, AdminAuditLog, AllowedUser, User } from '../../models/index.js';
import { HttpError } from '../errors.js';
import { reserveAttempts } from '../rate-window.js';
import { opaque } from '../auth/accounts.js';
import { sendQuietly } from '../notifications/emails.js';

const KEEP_DECIDED_MS = 90 * 24 * 60 * 60_000;

const requestSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(320),
  phone: z
    .string()
    .trim()
    .max(20)
    .regex(/^[+\d\s-]*$/, 'Enter a valid phone number.')
    .default(''),
  message: z.string().trim().max(1000).default(''),
  /** Hidden field people never see; bots fill it in. */
  website: z.string().max(200).default(''),
});

const origin = () => {
  try {
    return new URL(process.env.APP_URL || '').origin;
  } catch {
    return '';
  }
};

function toRequest(row) {
  return {
    id: row._id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    message: row.message,
    status: row.status,
    createdAt: row.createdAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

async function tellAdmins(request) {
  const admins = await User.find({ role: 'admin', status: 'active' }, { email: 1 }).lean();
  const link = origin() ? `Review the request: ${origin()}/admin/members` : null;
  await Promise.all(
    admins.map((admin) =>
      sendQuietly(admin.email, `New access request from ${request.name}`, [
        `${request.name} (${request.email}) asked to join Pirento Blank.`,
        request.phone ? `Phone: ${request.phone}` : null,
        request.message ? `\nTheir note:\n${request.message}` : null,
        '',
        link,
      ]),
    ),
  );
}

/**
 * POST /api/access-requests: records a request and emails the visitor and the administrators.
 * Bots (honeypot filled), existing members and repeat requests get the same answer, quietly.
 */
export async function submitAccessRequest(input, clientAddress) {
  const parsed = requestSchema.safeParse(input ?? {});
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 400);
  const body = parsed.data;
  if (body.website) return;
  const quota = await reserveAttempts(
    [
      { key: 'access-request:g', limit: 300 },
      { key: `access-request:c:${opaque('client', clientAddress || 'unidentified')}`, limit: 5 },
      { key: `access-request:i:${opaque('identifier', body.email)}`, limit: 2 },
    ],
    60 * 60_000,
  );
  if (!quota.allowed) {
    throw new HttpError('Too many requests. Try again in an hour.', 429, {
      retryAfter: quota.retryAfterSeconds,
    });
  }
  if (await AllowedUser.exists({ _id: body.email })) return;
  let request;
  try {
    request = await AccessRequest.create({
      name: body.name,
      email: body.email,
      phone: body.phone,
      message: body.message,
    });
  } catch (error) {
    // Already waiting for a decision: nothing new to send.
    if (error?.code === 11000) return;
    throw error;
  }
  await sendQuietly(request.email, 'We received your request to join Pirento Blank', [
    `Hi ${request.name},`,
    '',
    'Thank you for your interest in Pirento Blank. Your request has reached our team.',
    'When it is approved you will get another email with your sign-in details: you can sign in with the Google account for this address, or choose a password.',
    '',
    'If you did not make this request, ignore this email and nothing will happen.',
  ]);
  await tellAdmins(request);
}

/** The pending requests first, then the latest decided ones. */
export async function listAccessRequests() {
  const [pending, decided] = await Promise.all([
    AccessRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(200).lean(),
    AccessRequest.find({ status: { $ne: 'pending' } })
      .sort({ decidedAt: -1 })
      .limit(50)
      .lean(),
  ]);
  return [...pending, ...decided].map(toRequest);
}

/** The pending request with this id, or a 404. */
export async function pendingAccessRequest(id) {
  const request = await AccessRequest.findOne({ _id: String(id), status: 'pending' }).lean();
  if (!request) throw new HttpError('This request was already handled or no longer exists.', 404);
  return request;
}

/**
 * Records the decision (once: a second administrator deciding at the same moment gets a 409),
 * writes the audit log and, for a rejection, emails the visitor politely.
 */
export async function recordAccessDecision(request, status, actor) {
  const now = new Date();
  const updated = await AccessRequest.findOneAndUpdate(
    { _id: request._id, status: 'pending' },
    {
      $set: {
        status,
        decidedBy: actor.id,
        decidedAt: now,
        purgeAt: new Date(now.getTime() + KEEP_DECIDED_MS),
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw new HttpError('Another administrator already handled this request.', 409);
  await AdminAuditLog.create({
    actorId: actor.id,
    actorEmail: actor.email,
    action: `access-request.${status === 'approved' ? 'approve' : 'reject'}`,
    target: request.email,
  });
  if (status === 'rejected') {
    await sendQuietly(request.email, 'About your request to join Pirento Blank', [
      `Hi ${request.name},`,
      '',
      'Thank you for your interest in Pirento Blank. We are not able to open an account for you right now.',
      'This is usually because we are admitting a limited number of members at a time. You are welcome to ask again later.',
    ]);
  }
  return toRequest(updated);
}
