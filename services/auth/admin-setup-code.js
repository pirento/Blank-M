/**
 * The one-time code an administrator needs to add their first authenticator.
 *
 * A stolen admin password alone must not be enough to add an authenticator (which unlocks every
 * admin change). So an administrator without one first needs a one-time code that only the real
 * owner can get: by email, or from the server itself (scripts/admin-setup-code.js).
 */
import { randomInt } from 'node:crypto';
import { AuthToken } from '../../models/index.js';
import { sha256Hex } from '../crypto.js';
import { sendMail } from '../mailer.js';

const ADMIN_SETUP_TTL_MS = 15 * 60_000;

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
    text: `Someone signed in to your administrator account with Google and wants to add an authenticator.\n\nSetup code (valid 15 minutes): ${code}\n\nIf this was not you, secure your Google account now and tell the other administrators.`,
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
