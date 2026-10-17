/**
 * Server-rendered pages: the workspace pages, landing, login, invitation and
 * emailed-link pages, and the 404 page.
 */
import { WORKSPACE_PARTS, loadWorkspace } from '../services/journal/workspace.js';
import { computeCurrentBalance } from '../shared/pnl.js';
import { env } from '../config/env.js';
import { hasOpenAiKey } from '../services/ai/openai-key.js';
import { isKiteConfigured } from '../services/market/index.js';
import { isMailConfigured } from '../services/mailer.js';
import { NAV_LINKS, ADMIN_NAV_GROUP } from '../config/nav.js';
import { createHash } from 'node:crypto';
import { openShareLink } from '../services/journal/share-links.js';
import { reserveAttempts } from '../services/rate-window.js';

const TITLES = Object.fromEntries(
  [...NAV_LINKS, ...ADMIN_NAV_GROUP.items].map((link) => [link.path, link.name]),
);

function integrations() {
  return {
    openai: hasOpenAiKey(),
    kite: isKiteConfigured(),
    google: env.googleAuthEnabled,
    email: isMailConfigured(),
  };
}

/**
 * Workspace pages: the server loads the parts of the owner's snapshot the page
 * uses (`data`, default: everything) and the view receives them both for server
 * rendering and as JSON for its browser module. `portfolioBalance` is derived
 * from trades and settings.
 */
export function workspacePage(
  view,
  { script = view, vendor = [], data: parts = [...WORKSPACE_PARTS, 'portfolioBalance'] } = {},
) {
  // The dock shows the watchlist count on every page.
  const wanted = new Set([...parts, 'watchlist']);
  const withBalance = wanted.delete('portfolioBalance');
  const load = new Set(wanted);
  if (withBalance) load.add('trades').add('settings');
  return async (req, res) => {
    const userId = req.member.userId;
    const snapshot = await loadWorkspace(userId, [...load]);
    const data = Object.fromEntries([...wanted].map((part) => [part, snapshot[part]]));
    if (withBalance) {
      data.portfolioBalance = computeCurrentBalance(
        snapshot.settings.openingBalance,
        snapshot.trades,
      );
    }
    const health = integrations();
    res.renderWorkspace(`pages/${view}`, {
      title: res.locals.t(TITLES[req.path] ?? 'Workspace'),
      script,
      vendor,
      workspace: data,
      health,
      pageData: {
        accountId: userId,
        sessionId: req.member.session.sessionId,
        email: req.member.user.email,
        role: req.member.user.role,
        status: req.member.user.status ?? 'active',
        loginMethod: req.member.session.method ?? 'password',
        health: { ...health, aiAvailable: health.openai },
        workspace: data,
        query: req.query,
      },
    });
  };
}

/**
 * GET /: the landing page for visitors, the authenticator challenge when one is pending, or a
 * redirect to /dashboard (or the recovery form) for a signed-in member.
 */
export function landing(req, res) {
  const { user, accessError, mfaRequired, passwordRecovery } = req.auth;
  if (mfaRequired) return res.render('pages/mfa-challenge', { title: 'Verify' });
  if (passwordRecovery) return res.redirect('/login?mode=recover');
  if (!user) return res.render('pages/landing', { title: 'Blank' });
  if (accessError) {
    return res.status(403).render('pages/access-denied', { title: 'Access', error: accessError });
  }
  res.redirect('/dashboard');
}

/**
 * GET /login: the sign-in page in signin, activate, recover or reset mode (from ?mode= and the
 * session). A signed-in member asking to sign in is sent to /dashboard.
 */
export function login(req, res) {
  const { user, mfaRequired, passwordRecovery, session } = req.auth;
  if (mfaRequired) return res.render('pages/mfa-challenge', { title: 'Verify' });
  const requested = req.query.mode;
  const activation = Boolean(session?.activation);
  const mode =
    requested === 'activate' || activation
      ? 'activate'
      : passwordRecovery || requested === 'recover' || (requested === 'reset' && user)
        ? 'recover'
        : requested === 'reset'
          ? 'reset'
          : 'signin';
  if (user && mode === 'signin' && !req.auth.accessError) return res.redirect('/dashboard');
  const errors = {
    google: 'Google sign-in could not be completed. Try again or use your password.',
    google_unavailable: 'Google sign-in is not configured for this workspace.',
    invite_only: 'Blank is invite-only. Ask your workspace administrator for access.',
  };
  res.render('pages/login', {
    title: 'Sign in',
    mode,
    googleEnabled: env.googleAuthEnabled,
    mailConfigured: isMailConfigured(),
    passwordUser: (mode === 'activate' || mode === 'recover') && user ? user.email : null,
    initialError: errors[req.query.error] ?? null,
  });
}

/** GET /invite: the manual invitation acceptance page, sent with no referrer. */
export function invite(_req, res) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.render('pages/accept-invitation', { title: 'Accept invitation' });
}

/**
 * GET /auth/link/(activate|recover): the page that exchanges an emailed link, sent with no
 * referrer.
 */
export function authLink(req, res) {
  const purpose = req.params.purpose === 'activate' ? 'activate' : 'recover';
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.render('pages/auth-link', { title: 'Continue', purpose });
}

/** GET /share/:token — a member's read-only journal for a mentor (no sign-in). */
export async function sharedJournal(req, res) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  // Tokens cannot be guessed; the limit only slows scanning from one address.
  const client = createHash('sha256')
    .update(`share:${req.ip || 'unknown'}`)
    .digest('hex')
    .slice(0, 32);
  const quota = await reserveAttempts([{ key: `share:${client}`, limit: 120 }], 60_000);
  const shared = quota.allowed ? await openShareLink(req.params.token) : null;
  if (!shared) {
    return res.status(quota.allowed ? 404 : 429).render('pages/error', {
      title: 'Link unavailable',
      status: quota.allowed ? 404 : 429,
      message: quota.allowed
        ? 'This share link is invalid, expired or was revoked. Ask for a new link.'
        : 'Too many requests. Wait a minute and try again.',
    });
  }
  res.render('pages/share', { title: shared.label || 'Shared journal', shared });
}

/**
 * Final 404 handler: the plain error page when signed out or blocked, otherwise inside the
 * workspace.
 */
export function notFound(req, res) {
  if (!req.auth.user || req.auth.accessError || req.auth.mfaRequired) {
    return res.status(404).render('pages/error', {
      title: 'Not found',
      status: 404,
      message: 'This page does not exist.',
    });
  }
  res.status(404);
  res.renderWorkspace('pages/not-found', { title: 'Page not found', script: null, pageData: null });
}
