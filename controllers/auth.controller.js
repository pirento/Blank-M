/**
 * Sign-in endpoints: password and username login, sign-out, password recovery,
 * emailed link exchange, setting a password and Google sign-in.
 */
import { randomBytes } from 'node:crypto';
import { AllowedUser, User } from '../models/index.js';
import {
  accessProblem,
  consumeLinkToken,
  destroySession,
  establishSession,
  recordSignIn,
  requestPasswordRecovery,
  revokeUserSessions,
  signUp,
  updatePassword,
  verifyPasswordSignIn,
} from '../services/auth/accounts.js';
import { HttpError } from '../services/errors.js';
import { env } from '../config/env.js';
import { clientAddress } from '../services/http.js';
import { loadPlan } from '../services/billing/plan.js';
import { isMailConfigured } from '../services/mailer.js';

/** Password sign-in with an invited email or a claimed username. */
export async function login(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const user = await verifyPasswordSignIn(
    { identifier: req.body?.identifier, password: req.body?.password },
    clientAddress(req),
  );
  await establishSession(req, user, { method: 'password' });
  await recordSignIn(user);
  res.json({ ok: true, mfaRequired: user.hasVerifiedFactor(), csrfToken: req.session.csrfToken });
}

/**
 * POST /auth/admin/login: the admin panel's sign-in. Same checks and rate limits as
 * member sign-in, but only administrator accounts get a session; anyone else sees the
 * same "not recognised" answer, so the page does not reveal who is an administrator.
 */
export async function adminLogin(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const user = await verifyPasswordSignIn(
    { identifier: req.body?.identifier, password: req.body?.password },
    clientAddress(req),
  );
  if (user.role !== 'admin') {
    throw new HttpError('That username or email and password are not recognised.', 401);
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
  await updatePassword(user, req.body?.password);
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

/** Optional Google sign-in for already-invited addresses. It never creates access. */
export function googleStart(req, res) {
  if (!env.googleAuthEnabled || !env.appUrl) {
    res.redirect('/login?error=google_unavailable');
    return;
  }
  const state = randomBytes(32).toString('base64url');
  req.session.googleState = { value: state, expiresAt: Date.now() + 10 * 60_000 };
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
 * the matching invited account. Any failure redirects back to /login with an error code.
 */
export async function googleCallback(req, res) {
  const expected = req.session?.googleState;
  if (req.session) delete req.session.googleState;
  const fail = () => res.redirect('/login?error=google');
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
    const invitation = await AllowedUser.findById(email).lean();
    const user = invitation?.authUserId ? await User.findById(invitation.authUserId) : null;
    // Invite-only: Google can authenticate an invited identity, never create one.
    if (!invitation || invitation.revokedAt || !user || user.email !== email) {
      return res.redirect('/login?error=invite_only');
    }
    if (user.googleSubject && user.googleSubject !== profile.sub) return fail();
    user.googleSubject = profile.sub;
    user.emailConfirmedAt ??= new Date();
    if (!user.displayName && typeof profile.name === 'string')
      user.displayName = profile.name.slice(0, 120);
    await user.save();
    await AllowedUser.updateOne(
      { _id: email, acceptedAt: null },
      { $set: { acceptedAt: user.emailConfirmedAt } },
    );
    if (await accessProblem(user)) return res.redirect('/login?error=invite_only');
    await establishSession(req, user, { method: 'oauth' });
    await recordSignIn(user);
    res.redirect('/dashboard');
  } catch {
    fail();
  }
}
