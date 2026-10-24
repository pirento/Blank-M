/**
 * Sign-in endpoints: password and username login, sign-out, password recovery,
 * emailed link exchange, setting a password and Google sign-in.
 */
import { randomBytes } from 'node:crypto';
import { AllowedUser, User } from '../models/index.js';
import {
  accessProblem,
  confirmAccountOwner,
  consumeLinkToken,
  destroySession,
  establishSession,
  recordSignIn,
  requestPasswordRecovery,
  revokeUserSessions,
  signUp,
  updatePassword,
  verifyPasswordSignIn,
  signUpWithGoogle,
} from '../services/auth/accounts.js';
import { HttpError } from '../services/errors.js';
import { env } from '../config/env.js';
import { clientAddress } from '../services/http.js';
import { loadPlan } from '../services/billing/plan.js';
import { isMailConfigured } from '../services/mailer.js';
import { welcomeMember } from '../services/notifications/emails.js';
import { submitAccessRequest } from '../services/admin/access-requests.js';

/** Password sign-in with an invited email or a claimed username. */
export async function login(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const user = await verifyPasswordSignIn(
    { identifier: req.body?.identifier, password: req.body?.password },
    clientAddress(req),
  );
  // Only reached with the right password, so this reveals nothing to a guesser.
  if (user.role === 'admin') {
    throw new HttpError('Administrators sign in with Google on the admin sign-in page.', 403);
  }
  await establishSession(req, user, { method: 'password' });
  await recordSignIn(user);
  res.json({ ok: true, mfaRequired: user.hasVerifiedFactor(), csrfToken: req.session.csrfToken });
}

/**
 * POST /auth/logout: ends the session and clears its cookie; JSON callers get { ok }, others a
 * redirect to /login.
 */
export async function logout(req, res) {
  await destroySession(req);
  res.clearCookie('blank.sid');
  if ((req.get('accept') || '').includes('application/json')) res.json({ ok: true });
  else res.redirect('/login');
}

/**
 * POST /auth/signup { email }: public sign-up while the administrator has opened
 * it (admin panel → Plans & billing). Same answer whether or not the address
 * already has an account.
 */
export async function signup(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!(await loadPlan()).signupOpen) {
    throw new HttpError('Sign-up is closed. Ask the administrator for an invitation.', 403);
  }
  if (!isMailConfigured() || !env.appUrl) {
    throw new HttpError('Sign-up is not available right now. Try again later.', 503);
  }
  await signUp(req.body?.email, clientAddress(req));
  res.json({ ok: true });
}

/**
 * POST /auth/request-access { name, email, phone?, message? }: the home page's "Request access"
 * form. An administrator approves or rejects it in the admin panel → Members. Same answer for
 * every address.
 */
export async function requestAccess(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  await submitAccessRequest(req.body, clientAddress(req));
  res.json({ ok: true });
}

/** Same response whether or not the address is eligible. */
export async function recover(req, res) {
  await requestPasswordRecovery(req.body?.email, clientAddress(req));
  res.json({ ok: true });
}

/**
 * Exchange an emailed single-use link (activation or recovery) for a session
 * that may only set a password. The token arrives in the request body, never
 * a URL query, so it does not reach logs or referrers.
 */
export async function exchangeLink(req, res) {
  const purpose = req.body?.purpose === 'activate' ? 'activate' : 'recover';
  const user = await consumeLinkToken(req.body?.token, purpose);
  if (user.role === 'admin') {
    throw new HttpError('Administrators sign in with Google on the admin sign-in page.', 403);
  }
  await establishSession(req, user, { method: 'password', recovery: purpose === 'recover' });
  if (purpose === 'activate') {
    req.session.auth.activation = true;
    await new Promise((resolve, reject) =>
      req.session.save((error) => (error ? reject(error) : resolve())),
    );
  }
  res.json({
    ok: true,
    redirect: purpose === 'activate' ? '/login?mode=activate' : '/login?mode=recover',
    csrfToken: req.session.csrfToken,
  });
}

/** Choose a new password during activation/recovery, or change it while signed in. */
export async function setPassword(req, res) {
  const auth = req.auth;
  if (!auth?.user || !auth.session) {
    throw new HttpError('Open a valid invitation or recovery link before setting a password.', 401);
  }
  if (auth.mfaRequired) {
    throw new HttpError('Complete authenticator verification to continue.', 403);
  }
  const user = auth.user;
  const invitation = await AllowedUser.findById(user.email).lean();
  if (
    !invitation ||
    invitation.revokedAt ||
    user.status !== 'active' ||
    (user.bannedUntil && user.bannedUntil > new Date())
  ) {
    throw new HttpError('Blank is invite-only. Ask your workspace administrator for access.', 403);
  }
  // Outside a recovery or activation link, prove it is the owner (current password or a fresh
  // Google sign-in).
  const recovering = Boolean(req.session.auth?.passwordRecovery || req.session.auth?.activation);
  if (!recovering) {
    await confirmAccountOwner(user, req.session.auth, req.body?.currentPassword, 'password-change');
  }
  const activating = Boolean(req.session.auth?.activation) && !user.emailConfirmedAt;
  await updatePassword(user, req.body?.password);
  if (activating) void welcomeMember(user).catch(() => undefined);
  // Other sessions authenticated with the old password are ended.
  await revokeUserSessions(user._id, req.sessionID);
  req.session.auth.passwordRecovery = false;
  req.session.auth.activation = false;
  await new Promise((resolve, reject) =>
    req.session.save((error) => (error ? reject(error) : resolve())),
  );
  res.json({ ok: true, redirect: '/dashboard' });
}

/* ------------------------------ Google sign-in ------------------------------ */

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

function googleRedirectUri() {
  const origin = new URL(env.appUrl).origin;
  return `${origin}/auth/google/callback`;
}

/**
 * GET /auth/google[?for=admin]: starts Google sign-in. Members: an invited address, or a new
 * account while public sign-up is open. `for=admin` comes from the admin sign-in page and only
 * lets administrators in (then on to /admin).
 */
export function googleStart(req, res) {
  const forAdmin = req.query.for === 'admin';
  if (!env.googleAuthEnabled || !env.appUrl) {
    res.redirect(
      forAdmin ? '/admin/login?error=google_unavailable' : '/login?error=google_unavailable',
    );
    return;
  }
  const state = randomBytes(32).toString('base64url');
  req.session.googleState = { value: state, expiresAt: Date.now() + 10 * 60_000, forAdmin };
  const url = new URL(GOOGLE_AUTHORIZE);
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', googleRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  req.session.save(() => res.redirect(url.toString()));
}

/**
 * GET /auth/google/callback: checks the OAuth state, reads the verified Google profile and signs in
 * the matching account; while sign-up is open, a new Google address gets a new member account.
 * Any failure redirects back to the sign-in page it came from with an error code.
 */
export async function googleCallback(req, res) {
  const expected = req.session?.googleState;
  if (req.session) delete req.session.googleState;
  const loginPage = expected?.forAdmin ? '/admin/login' : '/login';
  const fail = () => res.redirect(`${loginPage}?error=google`);
  try {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (
      !env.googleAuthEnabled ||
      !expected ||
      expected.expiresAt < Date.now() ||
      state !== expected.value ||
      !code
    ) {
      return fail();
    }
    const tokenResponse = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = await tokenResponse.json().catch(() => null);
    if (!tokenResponse.ok || typeof tokens?.access_token !== 'string') return fail();
    const profileResponse = await fetch(GOOGLE_USERINFO, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const profile = await profileResponse.json().catch(() => null);
    const email = typeof profile?.email === 'string' ? profile.email.trim().toLowerCase() : '';
    if (
      !profileResponse.ok ||
      profile?.email_verified !== true ||
      !email ||
      typeof profile.sub !== 'string'
    ) {
      return fail();
    }
    let invitation = await AllowedUser.findById(email).lean();
    // A new address may join with Google while public sign-up is open (members only).
    let created = false;
    if (!invitation && !expected.forAdmin) {
      created = await signUpWithGoogle(email, clientAddress(req));
      if (created) invitation = await AllowedUser.findById(email).lean();
    }
    const user = invitation?.authUserId ? await User.findById(invitation.authUserId) : null;
    // Otherwise invite-only: Google can authenticate an invited identity, never create one.
    if (!invitation || invitation.revokedAt || !user || user.email !== email) {
      return res.redirect(`${loginPage}?error=invite_only`);
    }
    if (expected.forAdmin && user.role !== 'admin')
      return res.redirect(`${loginPage}?error=google`);
    if (user.googleSubject && user.googleSubject !== profile.sub) return fail();
    const firstSignIn = created || !user.emailConfirmedAt;
    user.googleSubject = profile.sub;
    user.emailConfirmedAt ??= new Date();
    if (!user.displayName && typeof profile.name === 'string')
      user.displayName = profile.name.slice(0, 120);
    await user.save();
    await AllowedUser.updateOne(
      { _id: email, acceptedAt: null },
      { $set: { acceptedAt: user.emailConfirmedAt } },
    );
    if (await accessProblem(user)) return res.redirect(`${loginPage}?error=invite_only`);
    await establishSession(req, user, { method: 'oauth' });
    await recordSignIn(user);
    if (firstSignIn) void welcomeMember(user).catch(() => undefined);
    // An administrator with an authenticator still has to enter its code (the /admin guard asks).
    res.redirect(expected.forAdmin ? '/admin' : '/dashboard');
  } catch {
    fail();
  }
}
