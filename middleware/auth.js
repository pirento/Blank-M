/**
 * Authentication middleware: loads the signed-in member on every request and
 * guards API routes and pages (member, administrator, MFA step-up).
 */
import { User } from '../models/index.js';
import { accessProblem } from '../services/auth/accounts.js';
import { HttpError } from '../services/errors.js';

/**
 * Resolve the session's account on every request. Membership, bans and the
 * current authenticator inventory are re-read, so a revocation or a newly
 * enrolled factor takes effect immediately for existing sessions.
 */
export async function loadAuth(req, res, next) {
  try {
    req.auth = {
      user: null,
      session: null,
      profile: null,
      mfaRequired: false,
      passwordRecovery: false,
      accessError: null,
    };
    const session = req.session?.auth;
    if (session?.userId) {
      const user = await User.findById(session.userId);
      if (!user) {
        delete req.session.auth;
      } else {
        const problem = await accessProblem(user);
        req.auth.user = user;
        req.auth.session = session;
        req.auth.accessError = problem;
        req.auth.mfaRequired = user.hasVerifiedFactor() && session.aal !== 'aal2';
        req.auth.passwordRecovery = Boolean(session.passwordRecovery || session.activation);
        if (!problem) {
          req.auth.profile = {
            role: user.role,
            status: user.status,
            displayName: user.displayName,
          };
        }
      }
    }
    res.locals.auth = req.auth;
    res.locals.currentUser = req.auth.user
      ? {
          id: req.auth.user._id,
          email: req.auth.user.email,
          role: req.auth.user.role,
          displayName: req.auth.user.displayName,
        }
      : null;
    res.locals.sessionIdentity = req.auth.session?.sessionId ?? '';
    next();
  } catch (error) {
    next(error);
  }
}

/** API equivalent of the original bearer-token check, with the same messages. */
export function authenticatedApi(req) {
  const { user, session, accessError, mfaRequired, passwordRecovery } = req.auth ?? {};
  if (!user || !session) throw new HttpError('Sign in to continue.', 401);
  if (accessError) throw new HttpError(accessError, accessError.startsWith('Confirm') ? 401 : 403);
  if (mfaRequired) throw new HttpError('Complete authenticator verification to continue.', 403);
  if (passwordRecovery) throw new HttpError('Set a new password before using the workspace.', 403);
  // A queued browser action is bound to the login session that rendered it.
  const expected = req.get('x-blank-session');
  if (expected && expected !== session.sessionId) {
    throw new HttpError('Your app session changed. Reload this page before continuing.', 409);
  }
  return { user, session, profile: req.auth.profile, userId: user._id };
}

/**
 * API guard: sets `req.member` for a fully signed-in member, otherwise passes the 401/403/409
 * HttpError on.
 */
export function requireApiAuth(req, _res, next) {
  try {
    req.member = authenticatedApi(req);
    next();
  } catch (error) {
    next(error);
  }
}

/** Page guard: unauthenticated visitors go to login; gated states render their own screens. */
export function requirePageAuth(req, res, next) {
  const { user, accessError, mfaRequired, passwordRecovery } = req.auth;
  if (!user) return res.redirect('/login');
  if (mfaRequired) return res.status(403).render('pages/mfa-challenge', { title: 'Verify' });
  if (passwordRecovery) {
    return res.redirect(
      req.session.auth.activation ? '/login?mode=activate' : '/login?mode=recover',
    );
  }
  if (accessError) {
    return res.status(403).render('pages/access-denied', { title: 'Access', error: accessError });
  }
  req.member = { user, userId: user._id, session: req.auth.session, profile: req.auth.profile };
  next();
}

/** Page guard after requirePageAuth: non-administrators are redirected to /dashboard. */
export function requirePageAdmin(req, res, next) {
  if (req.member?.user.role !== 'admin') return res.redirect('/dashboard');
  next();
}
