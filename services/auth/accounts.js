/**
 * Accounts and sign-in: password hashing, invite-only access checks, password
 * and username sign-in with rate limits, sign-in devices, sign-up, activation
 * and password recovery links. Sessions and the administrator setup code have
 * their own files.
 */
import { createHmac, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  AllowedUser,
  AuthToken,
  LoginUsername,
  USERNAME_PATTERN,
  User,
} from '../../models/index.js';
import { HttpError } from '../errors.js';
import { reserveAttempts } from '../rate-window.js';
import { sha256Hex } from '../crypto.js';
import { isMailConfigured, sendMail } from '../mailer.js';
import { newSignInEmail } from '../notifications/emails.js';
import { loadPlan } from '../billing/plan.js';
import { env } from '../../config/env.js';
import { createLogger, errorName } from '../logger.js';
import { describeDevice } from './sessions.js';

const log = createLogger('accounts');

export { USERNAME_PATTERN };
// Sessions and the administrator setup code have their own files; re-exported for existing importers.
export * from './sessions.js';
export * from './admin-setup-code.js';
export const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_ROUNDS = 12;
const INVALID = 'That username or email and password are not recognised.';
const ACCESS_DENIED = 'This account no longer has access to the workspace.';
const RECOVERY_TTL_MS = 60 * 60_000;
export const ACTIVATION_TTL_MS = 24 * 60 * 60_000;

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

export function opaque(namespace, value) {
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

/**
 * Stamps the last sign-in time and remembers the device (its coarse label, hashed) among the last
 * 10, in one update. A device not seen before is emailed about, except on the very first sign-in.
 */
export async function recordSignIn(user, userAgent) {
  const device = describeDevice(userAgent);
  const hash = opaque('device', device);
  const before = await User.findOneAndUpdate(
    { _id: user._id },
    [
      {
        $set: {
          lastSignInAt: new Date(),
          knownDevices: {
            $slice: [
              {
                $concatArrays: [
                  [hash],
                  {
                    $filter: {
                      input: { $ifNull: ['$knownDevices', []] },
                      cond: { $ne: ['$$this', hash] },
                    },
                  },
                ],
              },
              10,
            ],
          },
        },
      },
    ],
    { projection: { knownDevices: 1 } },
  ).lean();
  const known = before?.knownDevices ?? [];
  if (known.length && !known.includes(hash)) void newSignInEmail(user, device);
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
  // Administrators have no password (Google + authenticator), so there is nothing to reset.
  if (!user || user.role === 'admin' || (await accessProblem(user))) return;
  // Sent in the background, so members and strangers get the same answer just as fast.
  void (async () => {
    const token = await issueToken(user, 'recover', RECOVERY_TTL_MS);
    await sendMail({
      to: user.email,
      subject: 'Reset your Pirento Blank password',
      text: `A password reset was requested for your Pirento Blank account.\n\nChoose a new password within one hour:\nReset my password: ${appOrigin()}/auth/link/recover#token=${token}\n\nIf you did not request this, ignore this email; your password stays the same.`,
    });
  })().catch((error) => log.warn('recovery email not sent', { error: errorName(error) }));
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
export async function sendActivationEmail(user, { selfSignup = false, approved = false } = {}) {
  // Administrators have no password: they sign in with Google, then add an authenticator.
  if (user.role === 'admin') {
    await sendMail({
      to: user.email,
      subject: 'You are now a Pirento Blank administrator',
      text: [
        'You have been made an administrator of Pirento Blank.',
        '',
        `Sign in with Google: ${appOrigin()}/admin/login`,
        `Use the Google account for ${user.email}. After signing in you add an authenticator app (Google Authenticator or Authy); its setup code is emailed to you.`,
        '',
        'If you were not expecting this email, tell the other administrators.',
      ].join('\n'),
    });
    return;
  }
  const token = await issueToken(user, 'activate', ACTIVATION_TTL_MS);
  const origin = appOrigin();
  const link = `${origin}/auth/link/activate#token=${token}`;
  const support = process.env.SUPPORT_EMAIL?.trim();
  const [subject, intro, expired] = selfSignup
    ? [
        'Confirm your Pirento Blank account',
        'Welcome to Pirento Blank. Please confirm this is your email address.',
        `If the link has expired, sign up again with this address at ${origin}/signup for a new one.`,
      ]
    : approved
      ? [
          'Your Pirento Blank access is approved',
          'Good news: the Pirento Blank team has approved your request to join.',
          `If the link has expired, ${support ? `write to ${support}` : 'reply to this email'} and we will send you a new one.`,
        ]
      : [
          'Your Pirento Blank invitation',
          'The Pirento Blank team has invited you to join Pirento Blank, a private, invite-only workspace.',
          'If the link has expired, ask the person who invited you to send a new invitation.',
        ];
  await sendMail({
    to: user.email,
    subject,
    text: [
      intro,
      '',
      'Pirento Blank is a private journal for Indian traders: plan your trades, record them with real costs and review what works.',
      '',
      selfSignup
        ? 'Confirm your email and choose your password. The link works once and expires in 24 hours.'
        : 'Choose your password to activate your account. The link works once and expires in 24 hours.',
      `${selfSignup ? 'Confirm my account' : 'Set my password'}: ${link}`,
      ...(env.googleAuthEnabled
        ? [
            '',
            `Prefer Google? Sign in with the Google account for ${user.email}; no password needed.`,
            `Sign in with Google: ${origin}/login`,
          ]
        : []),
      '',
      expired,
      '',
      selfSignup
        ? 'If you did not sign up, ignore this email and no account will be created.'
        : 'If you were not expecting this email, you can ignore it.',
    ].join('\n'),
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
      sendSignupEmail(account);
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
  sendSignupEmail(account);
}

/** Sends the sign-up link in the background, so every address gets the same answer as fast. */
function sendSignupEmail(account) {
  void sendActivationEmail(account, { selfSignup: true }).catch((error) =>
    log.warn('sign-up email not sent', { error: errorName(error) }),
  );
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

/**
 * A new member signing up with Google while public sign-up is open: Google has verified the
 * address, so the account is confirmed at once. Returns true when an account was created (false
 * when sign-up is closed, rate-limited, or another request created it first).
 */
export async function signUpWithGoogle(email, clientAddress) {
  if (!(await loadPlan()).signupOpen) return false;
  const quota = await reserveAttempts(
    [
      { key: 'signup:g', limit: 200 },
      { key: `signup:c:${opaque('client', clientAddress || 'unidentified-client')}`, limit: 5 },
    ],
    60 * 60_000,
  );
  if (!quota.allowed) return false;
  let account;
  try {
    account = await User.create({
      email,
      role: 'member',
      status: 'active',
      emailConfirmedAt: new Date(),
    });
    await AllowedUser.create({
      _id: email,
      role: 'member',
      invitedBy: null,
      invitedAt: new Date(),
      acceptedAt: new Date(),
      authUserId: account._id,
    });
    return true;
  } catch (error) {
    // A parallel sign-up for the same address won; remove our half-made account.
    if (error?.code !== 11000) throw error;
    if (account) await User.deleteOne({ _id: account._id, passwordHash: null });
    return false;
  }
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

/**
 * A live session alone (an unattended browser, a stolen cookie) must not be enough to take over or
 * delete an account. A password account gives its current password; a Google-only account must
 * have signed in with Google in the last 10 minutes or used its authenticator in this session.
 * Limited like sign-in per `action`, so a live session cannot be used to guess the password.
 * Throws HttpError 403, or 429 after too many attempts.
 */
export async function confirmAccountOwner(user, signIn, currentPassword, action) {
  const quota = await reserveAttempts([{ key: `${action}:${user._id}`, limit: 5 }], 15 * 60_000);
  if (!quota.allowed) throw new HttpError('Too many attempts. Try again in 15 minutes.', 429);
  if (user.passwordHash) {
    const current = String(currentPassword ?? '');
    if (!current || current.length > 128 || !(await bcrypt.compare(current, user.passwordHash))) {
      throw new HttpError('Your current password is not correct.', 403);
    }
    return;
  }
  const fresh =
    signIn?.method === 'oauth' && Date.now() - (signIn.authenticatedAt ?? 0) < 10 * 60_000;
  if (!fresh && signIn?.aal !== 'aal2') {
    throw new HttpError(
      'Sign in with Google again (or use "Forgot password"), then try again.',
      403,
    );
  }
}
