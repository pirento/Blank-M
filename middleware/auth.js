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
      /** An administrator who has no authenticator yet: must add one before anything else. */
      mfaSetupRequired: false,
      passwordRecovery: false,
      accessError: null,
    };
    const session = req.session?.auth;
    if (session?.userId) {
      const user = await User.findById(session.userId);
      // Administrators sign in only with Google (then their authenticator). A session an
      // administrator got any other way (password, reset or activation link) is not accepted.
      if (!user || (user.role === 'admin' && session.method !== 'oauth')) {
        delete req.session.auth;
      } else {
        const problem = await accessProblem(user);
        req.auth.user = user;
        req.auth.session = session;
        req.auth.accessError = problem;
        req.auth.mfaRequired = user.hasVerifiedFactor() && session.aal !== 'aal2';
        req.auth.mfaSetupRequired = user.role === 'admin' && !user.hasVerifiedFactor();
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

/** The "add your authenticator" screen an administrator sees until they have one. */
export function renderMfaSetup(res) {
  return res.status(403).render('pages/mfa-setup', { title: 'Add an authenticator' });
}

/** API equivalent of the original bearer-token check, with the same messages. */
export function authenticatedApi(req) {
  const { user, session, accessError, mfaRequired, mfaSetupRequired, passwordRecovery } =
    req.auth ?? {};
  if (!user || !session) throw new HttpError('Sign in to continue.', 401);
  if (accessError) throw new HttpError(accessError, accessError.startsWith('Confirm') ? 401 : 403);
  if (mfaRequired) throw new HttpError('Complete authenticator verification to continue.', 403);
  if (mfaSetupRequired) {
    throw new HttpError('Administrators must add an authenticator before continuing.', 403);
  }
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
  if (req.auth.mfaSetupRequired) return renderMfaSetup(res);
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

/* ---------------------------------- admin panel ---------------------------------- */

/**
 * Page guard for /admin/*: signed-out visitors go to the admin sign-in page, a
 * pending authenticator check shows the challenge, and anyone who is not an
 * active administrator gets a plain 404 (the panel does not announce itself).
 */
export function requireAdminPage(req, res, next) {
  const { user, accessError, mfaRequired, passwordRecovery } = req.auth;
  if (!user || accessError) return res.redirect('/admin/login');
  if (mfaRequired) return res.status(403).render('pages/mfa-challenge', { title: 'Verify' });
  if (req.auth.mfaSetupRequired) return renderMfaSetup(res);
  if (passwordRecovery) return res.redirect('/login?mode=recover');
  if (user.role !== 'admin') {
    return res.status(404).render('pages/error', {
      title: 'Not found',
      status: 404,
      message: 'This page does not exist.',
    });
  }
  req.member = { user, userId: user._id, session: req.auth.session, profile: req.auth.profile };
  next();
}

/** API guard for /api/admin/*: a fully signed-in, active administrator (sets `req.member`). */
export function requireApiAdmin(req, _res, next) {
  try {
    req.member = authenticatedApi(req);
    if (req.member.user.role !== 'admin') {
      throw new HttpError('Administrator access is required.', 403);
    }
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * For admin actions that change secrets, money or access: the administrator must
 * have an authenticator and have used it in this session (aal2), so a stolen
 * password alone cannot change payment keys.
 */
export function requireAdminMfa(req, _res, next) {
  const { user, session } = req.member ?? {};
  if (!user?.hasVerifiedFactor?.()) {
    return next(
      new HttpError(
        'Add an authenticator first (Settings → Authenticator) — admin changes require it.',
        403,
      ),
    );
  }
  if (session?.aal !== 'aal2') {
    return next(new HttpError('Verify your authenticator again to make admin changes.', 403));
  }
  next();
}
