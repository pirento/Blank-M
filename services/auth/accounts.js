/**
 * Accounts and sign-in: password hashing, invite-only access checks, password
 * and username sign-in with rate limits, sessions and signed-in devices,
 * activation and password recovery links.
 */
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  AllowedUser,
  AuthToken,
  LoginUsername,
  USERNAME_PATTERN,
  User,
} from '../../models/index.js';
import { nativeDb } from '../../config/database.js';
import { HttpError } from '../errors.js';
import { reserveAttempts } from '../rate-window.js';
import { sha256Hex } from '../crypto.js';
import { isMailConfigured, sendMail } from '../mailer.js';

export { USERNAME_PATTERN };
export const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_ROUNDS = 12;
const INVALID = 'That username or email and password are not recognised.';
const ACCESS_DENIED = 'This account no longer has access to the workspace.';
const RECOVERY_TTL_MS = 60 * 60_000;
export const ACTIVATION_TTL_MS = 24 * 60 * 60_000;
const ADMIN_SETUP_TTL_MS = 15 * 60_000;

// A fixed hash compared for unknown identities so a missing account does not
// return measurably faster than a wrong password.
const DUMMY_HASH = bcrypt.hashSync('blank-unavailable-identity', BCRYPT_ROUNDS);

/** bcrypt hash of a password (12 rounds). */
export function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function quotaSecret() {
  return process.env.SESSION_SECRET || 'blank-development-quota-key';
}

function opaque(namespace, value) {
  return createHmac('sha256', quotaSecret())
    .update(`blank-login:${namespace}\0${value}`)
    .digest('hex');
}

/** Current workspace eligibility, re-read on every authenticated request. */
export async function accessProblem(user, now = Date.now()) {
  if (!user) return 'Your session is invalid or expired. Sign in again.';
  if (user.status !== 'active') return ACCESS_DENIED;
  if (user.bannedUntil && user.bannedUntil.getTime() > now) return ACCESS_DENIED;
  if (!user.emailConfirmedAt) return 'Confirm your email before signing in.';
  const invitation = await AllowedUser.findOne({ authUserId: user._id }).lean();
  if (!invitation || invitation.revokedAt) return ACCESS_DENIED;
  return null;
}

const signInSchema = z
  .object({
    identifier: z.string().trim().min(1).max(320),
    // Do not trim or reinterpret an existing password.
    password: z.string().min(1).max(128),
  })
  .strict();

/**
 * Password sign-in by invited email or claimed username. Every bucket (global,
 * client, identifier) is reserved before verification, so guessing is bounded
 * across all server processes. Unknown, revoked and unconfirmed identities all
 * produce the same failure.
 */
export async function verifyPasswordSignIn(input, clientAddress) {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(INVALID, 401);
  const identifier = parsed.data.identifier.toLowerCase();
  const emailLogin = identifier.includes('@');
  if (!emailLogin && !USERNAME_PATTERN.test(identifier)) throw new HttpError(INVALID, 401);

  // No platform-wide bucket: successful sign-ins would count too, and a morning rush (or an
  // attacker spread over many addresses) could lock every member out.
  const quota = await reserveAttempts(
    [
      { key: `login:c:${opaque('client', clientAddress || 'unidentified-client')}`, limit: 60 },
      { key: `login:i:${opaque('identifier', identifier)}`, limit: 10 },
    ],
    15 * 60_000,
  );
  if (!quota.allowed) {
    throw new HttpError('Too many attempts. Wait a few minutes and try again.', 429, {
      retryAfter: quota.retryAfterSeconds,
    });
  }

  let user = null;
  if (emailLogin) {
    user = await User.findOne({ email: identifier });
  } else {
    const alias = await LoginUsername.findById(identifier).lean();
    user = alias?.userId ? await User.findById(alias.userId) : null;
  }
  const matches = await bcrypt.compare(parsed.data.password, user?.passwordHash || DUMMY_HASH);
  if (!user || !user.passwordHash || !matches) throw new HttpError(INVALID, 401);
  const problem = await accessProblem(user);
  if (problem) {
    // Unconfirmed and revoked identities never learn which condition failed.
    throw new HttpError(INVALID, 401);
  }
  if (!emailLogin) {
    // Re-resolve after verification: the alias must still name this identity.
    const current = await LoginUsername.findById(identifier).lean();
    if (current?.userId !== user._id) throw new HttpError(INVALID, 401);
  }
  return user;
}

/** A coarse, human-readable device label; the raw user agent is not stored. */
export function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
}

/**
 * Regenerates the session (preventing fixation), stores the auth record with a new public session
 * ID and device label, and issues a fresh CSRF token. Resolves once the session is saved.
 */
export function establishSession(req, user, { method = 'password', recovery = false } = {}) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.auth = {
        userId: user._id,
        sessionId: randomUUID(),
        aal: 'aal1',
        method,
        authenticatedAt: Date.now(),
        passwordRecovery: recovery,
        device: describeDevice(req.get?.('user-agent')),
      };
      req.session.csrfToken = randomBytes(32).toString('base64url');
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

/**
 * Destroys the request's session, if any. Always resolves, even when the store reports an error.
 */
export function destroySession(req) {
  return new Promise((resolve) => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });
}

/** The member's signed-in sessions, newest activity first. */
export async function listUserSessions(userId, currentSessionId, maxAgeMs) {
  const rows = await nativeDb()
    .collection('sessions')
    .find({ 'session.auth.userId': userId }, { projection: { expires: 1, 'session.auth': 1 } })
    .toArray();
  return rows
    .filter((row) => row.session?.auth?.sessionId)
    .map((row) => {
      const auth = row.session.auth;
      const expires = row.expires ? new Date(row.expires).getTime() : null;
      return {
        id: auth.sessionId,
        device: auth.device || 'Unknown device',
        method: auth.method === 'oauth' ? 'Google' : 'Password',
        signedInAt: auth.authenticatedAt ? new Date(auth.authenticatedAt).toISOString() : null,
        lastActiveAt: expires && maxAgeMs ? new Date(expires - maxAgeMs).toISOString() : null,
        current: auth.sessionId === currentSessionId,
      };
    })
    .sort((left, right) => String(right.lastActiveAt).localeCompare(String(left.lastActiveAt)));
}

/** End one other session of this member, identified by its public session ID. */
export async function revokeUserSession(userId, sessionId) {
  const result = await nativeDb()
    .collection('sessions')
    .deleteOne({ 'session.auth.userId': userId, 'session.auth.sessionId': sessionId });
  return result.deletedCount === 1;
}

/** Revoke every server session for a user (membership revocation, password change). */
export async function revokeUserSessions(userId, exceptSessionId = null) {
  const filter = { 'session.auth.userId': userId };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  await nativeDb().collection('sessions').deleteMany(filter);
}

/** Stamps the member's last sign-in time. */
export async function recordSignIn(user) {
  await User.updateOne({ _id: user._id }, { $set: { lastSignInAt: new Date() } });
}

function appOrigin() {
  let origin;
  try {
    origin = new URL(process.env.APP_URL || '');
  } catch {
    throw new HttpError('APP_URL is not configured.', 503);
  }
  return origin.origin;
}

async function issueToken(user, purpose, ttlMs) {
  const token = randomBytes(32).toString('base64url');
  await AuthToken.updateMany(
    { userId: user._id, purpose, usedAt: null },
    { $set: { usedAt: new Date() } },
  );
  await AuthToken.create({
    tokenHash: sha256Hex(token),
    purpose,
    userId: user._id,
    email: user.email,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

/** Same response whether or not the address is eligible. */
export async function requestPasswordRecovery(email, address = 'unknown') {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!z.string().email().max(320).safeParse(normalized).success) {
    throw new HttpError('Enter a valid email address.', 400);
  }
  const quota = await reserveAttempts(
    [
      { key: 'recover:g', limit: 200 },
      { key: `recover:i:${opaque('recover', normalized)}`, limit: 3 },
      // One client cannot use up the global cap for everyone.
      { key: `recover:a:${opaque('recover-address', address)}`, limit: 20 },
    ],
    60 * 60_000,
  );
  if (!quota.allowed) throw new HttpError('Too many attempts. Wait a minute and try again.', 429);
  // Decide before any account lookup, so the response never reveals whether an
  // address belongs to a member.
  if (!isMailConfigured()) {
    throw new HttpError(
      'Password reset email is not available in this workspace. Ask your administrator for a reset link.',
      503,
    );
  }
  const user = await User.findOne({ email: normalized });
  if (!user || (await accessProblem(user))) return;
  const token = await issueToken(user, 'recover', RECOVERY_TTL_MS);
  await sendMail({
    to: user.email,
    subject: 'Reset your Pirento Blank password',
    text: `A password reset was requested for your Pirento Blank account.\n\nOpen this link within one hour to choose a new password:\n${appOrigin()}/auth/link/recover#token=${token}\n\nIf you did not request this, you can ignore this email.`,
  });
}

/**
 * A one-hour, single-use password reset link created by an administrator and
 * shared out of band. Issuing it invalidates any earlier unused reset link.
 */
export async function createRecoveryLink(user) {
  const origin = appOrigin();
  const token = await issueToken(user, 'recover', RECOVERY_TTL_MS);
  return {
    url: `${origin}/auth/link/recover#token=${token}`,
    expiresAt: new Date(Date.now() + RECOVERY_TTL_MS).toISOString(),
  };
}

/**
 * Emails a 24-hour, single-use activation link to an invited member; any earlier unused activation
 * link stops working.
 */
export async function sendActivationEmail(user, { selfSignup = false } = {}) {
  const token = await issueToken(user, 'activate', ACTIVATION_TTL_MS);
  const link = `${appOrigin()}/auth/link/activate#token=${token}`;
  await sendMail({
    to: user.email,
    subject: selfSignup ? 'Confirm your Pirento Blank account' : 'Your Pirento Blank invitation',
    text: selfSignup
      ? `Welcome to Pirento Blank.\n\nOpen this link within 24 hours to confirm your email and choose your password:\n${link}\n\nIf you did not sign up, ignore this email and no account will be created.`
      : `You have been invited to a private Pirento Blank workspace.\n\nOpen this link within 24 hours to choose your password:\n${link}\n\nThe workspace is invite-only; ignore this email if you were not expecting it.`,
  });
}

/**
 * Public sign-up (only while the administrator has opened it): creates the
 * allowlist row and an unconfirmed account, then emails an activation link.
 * Always answers the same way, so it cannot be used to find out who has an
 * account; an existing unconfirmed sign-up simply gets a fresh link.
 */
export async function signUp(email, clientAddress) {
  const parsed = z.string().trim().toLowerCase().email().max(320).safeParse(email);
  if (!parsed.success) throw new HttpError('Enter a valid email address.', 400);
  const address = parsed.data;
  const quota = await reserveAttempts(
    [
      { key: 'signup:g', limit: 200 },
      { key: `signup:c:${opaque('client', clientAddress || 'unidentified-client')}`, limit: 5 },
      { key: `signup:i:${opaque('identifier', address)}`, limit: 3 },
    ],
    60 * 60_000,
  );
  if (!quota.allowed) {
    throw new HttpError('Too many sign-up attempts. Try again in an hour.', 429, {
      retryAfter: quota.retryAfterSeconds,
    });
  }
  const invitation = await AllowedUser.findById(address).lean();
  if (invitation) {
    const account = invitation.authUserId ? await User.findById(invitation.authUserId) : null;
    // Only a sign-up that was never confirmed gets a new link; everyone else nothing.
    if (
      account &&
      !account.emailConfirmedAt &&
      !invitation.revokedAt &&
      account.status === 'active'
    ) {
      await sendActivationEmail(account, { selfSignup: true });
    }
    return;
  }
  if (await User.exists({ email: address })) return;
  let account;
  try {
    account = await User.create({ email: address, role: 'member', status: 'active' });
    await AllowedUser.create({
      _id: address,
      role: 'member',
      invitedBy: null,
      invitedAt: new Date(),
      authUserId: account._id,
    });
  } catch (error) {
    // A parallel sign-up for the same address won; remove our half-made account.
    if (error?.code !== 11000) throw error;
    if (account) await User.deleteOne({ _id: account._id, emailConfirmedAt: null });
    return;
  }
  await sendActivationEmail(account, { selfSignup: true });
}

/**
 * Removes public sign-ups whose email was never confirmed after `days` days (the link lasts 24
 * hours), so typos and abandoned sign-ups do not pile up. Admin invitations are left alone, and so
 * is anyone holding a still-valid activation link. Returns how many were removed.
 */
export async function deleteUnconfirmedSignups({ days = 7, now = new Date() } = {}) {
  const before = new Date(now.getTime() - days * 24 * 60 * 60_000);
  const stale = await AllowedUser.find(
    { invitedBy: null, acceptedAt: null, invitedAt: { $lt: before }, authUserId: { $ne: null } },
    { authUserId: 1 },
  )
    .limit(1000)
    .lean();
  let removed = 0;
  for (const row of stale) {
    const linkStillValid = await AuthToken.exists({
      userId: row.authUserId,
      purpose: 'activate',
      usedAt: null,
      expiresAt: { $gt: now },
    });
    if (linkStillValid) continue;
    // Conditional: someone confirming right now keeps their account.
    const gone = await User.deleteOne({
      _id: row.authUserId,
      role: 'member',
      emailConfirmedAt: null,
      passwordHash: null,
    });
    if (!gone.deletedCount) continue;
    await AllowedUser.deleteOne({ _id: row._id, authUserId: row.authUserId, acceptedAt: null });
    removed += 1;
  }
  return removed;
}

/* ------------------------- first authenticator for an administrator ------------------------- */
// A stolen admin password alone must not be enough to add an authenticator (which unlocks every
// admin change). So an administrator without one first needs a one-time code that only the real
// owner can get: by email, or from the server itself (scripts/admin-setup-code.js).

// The user id is part of the hash: two administrators can get the same 8 digits.
const setupCodeHash = (userId, code) => sha256Hex(`admin-mfa\0${userId}\0${code}`);

/** A new 8-digit, 15-minute setup code for this administrator; earlier unused codes stop working. */
export async function issueAdminSetupCode(user) {
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  await AuthToken.updateMany(
    { userId: user._id, purpose: 'admin-mfa', usedAt: null },
    { $set: { usedAt: new Date() } },
  );
  await AuthToken.create({
    tokenHash: setupCodeHash(user._id, code),
    purpose: 'admin-mfa',
    userId: user._id,
    email: user.email,
    expiresAt: new Date(Date.now() + ADMIN_SETUP_TTL_MS),
  });
  return code;
}

/** Emails a setup code to the administrator (callers check isMailConfigured first). */
export async function emailAdminSetupCode(user) {
  const code = await issueAdminSetupCode(user);
  await sendMail({
    to: user.email,
    subject: 'Your Pirento Blank authenticator setup code',
    text: `Someone signed in to your administrator account and wants to add an authenticator.\n\nSetup code (valid 15 minutes): ${code}\n\nIf this was not you, change your password now: someone knows it.`,
  });
}

/** Uses up a setup code; true only for this administrator's latest unexpired, unused code. */
export async function consumeAdminSetupCode(user, code) {
  if (!/^\d{8}$/.test(String(code ?? ''))) return false;
  const now = new Date();
  const record = await AuthToken.findOneAndUpdate(
    {
      tokenHash: setupCodeHash(user._id, String(code)),
      purpose: 'admin-mfa',
      userId: user._id,
      usedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { usedAt: now } },
  );
  return Boolean(record);
}

/** Consume a single-use emailed link and return its account. */
export async function consumeLinkToken(token, purpose) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token || ''))) {
    throw new HttpError('This link is invalid or has expired. Request a new one.', 400);
  }
  const now = new Date();
  const record = await AuthToken.findOneAndUpdate(
    { tokenHash: sha256Hex(token), purpose, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true },
  );
  if (!record) throw new HttpError('This link is invalid or has expired. Request a new one.', 400);
  const user = await User.findById(record.userId);
  if (!user || user.email !== record.email) {
    throw new HttpError('This link is invalid or has expired. Request a new one.', 400);
  }
  const invitation = await AllowedUser.findById(user.email);
  if (
    !invitation ||
    invitation.revokedAt ||
    user.status !== 'active' ||
    (user.bannedUntil && user.bannedUntil > now)
  ) {
    throw new HttpError('Blank is invite-only. Ask your workspace administrator for access.', 403);
  }
  return user;
}

/**
 * Stores a new bcrypt password hash (8–128 characters, else HttpError 400), confirms the email if
 * it was not yet, and marks the invitation accepted.
 */
export async function updatePassword(user, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
  }
  if (password.length > 128) throw new HttpError('Use at most 128 characters.', 400);
  const now = new Date();
  const confirmedAt = user.emailConfirmedAt ?? now;
  await User.updateOne(
    { _id: user._id },
    { $set: { passwordHash: await hashPassword(password), emailConfirmedAt: confirmedAt } },
  );
  await AllowedUser.updateOne(
    { _id: user.email, acceptedAt: null },
    { $set: { acceptedAt: confirmedAt } },
  );
}
