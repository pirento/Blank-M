/**
 * Authenticator (TOTP) management: list, enrol, verify and remove factors.
 */
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { User } from '../models/index.js';
import { decryptMfaSecret, encryptMfaSecret } from '../services/crypto.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../services/auth/totp.js';
import { HttpError } from '../services/errors.js';
import { reserveAttempts } from '../services/rate-window.js';
import {
  accessProblem,
  consumeAdminSetupCode,
  emailAdminSetupCode,
  revokeUserSessions,
} from '../services/auth/accounts.js';
import { isMailConfigured } from '../services/mailer.js';

const CODE_FAILED =
  'The code could not be verified. Use the latest code from your authenticator and try again.';
const MAX_FACTORS = 10;

/** Signed-in (aal1 is enough) account whose membership is still active. */
async function signedInUser(req) {
  const { user, session } = req.auth ?? {};
  if (!user || !session) throw new HttpError('Sign in to continue.', 401);
  const problem = await accessProblem(user);
  if (problem) throw new HttpError(problem, 403);
  const expected = req.get('x-blank-session');
  if (expected && expected !== session.sessionId) {
    throw new HttpError('The account changed during verification.', 409);
  }
  return user;
}

function publicFactor(factor, index) {
  return {
    id: factor._id,
    friendly_name: factor.friendlyName || `Authenticator ${index + 1}`,
    factor_type: factor.factorType,
    status: factor.status,
  };
}

async function limitCodes(userId) {
  const quota = await reserveAttempts([{ key: `mfa:${userId}`, limit: 10 }], 5 * 60_000);
  if (!quota.allowed) {
    throw new HttpError('Too many attempts. Wait a few minutes and try again.', 429, {
      retryAfter: quota.retryAfterSeconds,
    });
  }
}

async function checkCode(user, factorId, code) {
  const factor = user.factors.find((item) => item._id === factorId);
  if (!factor || factor.factorType !== 'totp') throw new HttpError(CODE_FAILED, 400);
  await limitCodes(user._id);
  const step = verifyTotp(decryptMfaSecret(factor.secret), String(code ?? ''), {
    lastUsedStep: factor.lastUsedStep,
  });
  if (step === null) throw new HttpError(CODE_FAILED, 400);
  // Conditional write: two concurrent submissions of one code cannot both pass.
  const updated = await User.updateOne(
    {
      _id: user._id,
      factors: {
        $elemMatch: {
          _id: factorId,
          $or: [{ lastUsedStep: null }, { lastUsedStep: { $lt: step } }],
        },
      },
    },
    { $set: { 'factors.$.lastUsedStep': step } },
  );
  if (!updated.modifiedCount) throw new HttpError(CODE_FAILED, 400);
  return factor;
}

function saveSession(req) {
  return new Promise((resolve, reject) =>
    req.session.save((error) => (error ? reject(error) : resolve())),
  );
}

/** GET /auth/mfa/factors: the member's authenticators and the session's assurance level. */
export async function listFactors(req, res) {
  const user = await signedInUser(req);
  res.json({ all: user.factors.map(publicFactor), aal: req.auth.session.aal });
}

/** An administrator who has no authenticator yet: adding the first one needs a setup code. */
const needsSetupCode = (user) => user.role === 'admin' && !user.hasVerifiedFactor();

/**
 * POST /auth/mfa/admin-code: emails a one-time setup code to an administrator who has no
 * authenticator yet. Without email the code comes from the server: scripts/admin-setup-code.js.
 */
export async function sendAdminSetupCode(req, res) {
  const user = await signedInUser(req);
  if (!needsSetupCode(user)) throw new HttpError('No setup code is needed for this account.', 400);
  if (!isMailConfigured()) {
    throw new HttpError(
      'Email is not set up, so get the code on the server: node scripts/admin-setup-code.js your@email',
      503,
    );
  }
  const quota = await reserveAttempts([{ key: `mfa-code:${user._id}`, limit: 3 }], 60 * 60_000);
  if (!quota.allowed) {
    throw new HttpError('Too many codes requested. Wait an hour and try again.', 429, {
      retryAfter: quota.retryAfterSeconds,
    });
  }
  await emailAdminSetupCode(user);
  res.json({ sent: true });
}

/**
 * Begin authenticator setup. Adding a factor to a protected account requires aal2; an
 * administrator's first factor requires a setup code ({ setupCode }), so a stolen password alone
 * cannot add one.
 */
export async function enroll(req, res) {
  const user = await signedInUser(req);
  if (user.hasVerifiedFactor() && req.auth.session.aal !== 'aal2') {
    throw new HttpError('Complete authenticator verification to continue.', 403);
  }
  if (needsSetupCode(user)) {
    await limitCodes(user._id);
    if (!(await consumeAdminSetupCode(user, req.body?.setupCode))) {
      throw new HttpError(
        'Administrators need a setup code to add their first authenticator.',
        403,
        { code: 'admin_setup_code_required' },
      );
    }
  }
  if (user.factors.filter((factor) => factor.status === 'unverified').length >= 3) {
    throw new HttpError('Finish or remove unfinished authenticator setup first.', 409);
  }
  // Factors live inside the user document, so their number is capped.
  if (user.factors.length >= MAX_FACTORS) {
    throw new HttpError(`You can have at most ${MAX_FACTORS} authenticators.`, 409);
  }
  const secret = generateTotpSecret();
  const id = randomUUID();
  const friendlyName = `Blank authenticator ${id.slice(0, 8)}`;
  await User.updateOne(
    { _id: user._id },
    {
      $push: {
        factors: {
          _id: id,
          factorType: 'totp',
          friendlyName,
          status: 'unverified',
          secret: encryptMfaSecret(secret),
        },
      },
    },
  );
  const uri = otpauthUri({ secret, accountName: user.email });
  const qrCode = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  res.status(201).json({ id, secret, qrCode, uri });
}

/** Verify an enrollment or complete the sign-in challenge; either way the session becomes aal2. */
export async function verify(req, res) {
  const user = await signedInUser(req);
  const factor = await checkCode(user, req.body?.factorId, req.body?.code);
  if (factor.status === 'unverified') {
    await User.updateOne(
      { _id: user._id, 'factors._id': factor._id },
      { $set: { 'factors.$.status': 'verified', 'factors.$.verifiedAt': new Date() } },
    );
    // Sessions issued before enrollment must not retain access.
    await revokeUserSessions(user._id, req.sessionID);
  }
  req.session.auth.aal = 'aal2';
  await saveSession(req);
  res.json({ ok: true });
}

/**
 * POST /auth/mfa/unenroll { factorId, code? }: removes an authenticator. A verified one needs an
 * aal2 session and a fresh code; the session drops to aal1 when no verified factor remains.
 */
export async function unenroll(req, res) {
  const user = await signedInUser(req);
  const factorId = req.body?.factorId;
  const factor = user.factors.find((item) => item._id === factorId);
  if (!factor) throw new HttpError('Authenticator not found.', 404);
  if (factor.status === 'verified') {
    // Require aal2 and a fresh code even when this session is already verified.
    if (req.auth.session.aal !== 'aal2') {
      throw new HttpError('Complete authenticator verification to continue.', 403);
    }
    await checkCode(user, factorId, req.body?.code);
  }
  await User.updateOne({ _id: user._id }, { $pull: { factors: { _id: factorId } } });
  const remaining = await User.findById(user._id);
  if (!remaining.hasVerifiedFactor()) {
    req.session.auth.aal = 'aal1';
    await saveSession(req);
  }
  res.json({ ok: true });
}
