/**
 * Authenticated member lookup for API handlers (and the administrator check).
 */
import { authenticatedApi } from '../../middleware/auth.js';
import { HttpError } from '../errors.js';

/**
 * The authenticated member for an API request, in the shape the original
 * handlers used: `user.id`, the workspace profile and an opaque session token.
 */
export async function authenticateRequest(req) {
  const auth = authenticatedApi(req);
  return {
    user: { id: auth.user._id, email: auth.user.email },
    profile: { role: auth.user.role, status: auth.user.status },
    token: auth.session.sessionId,
    session: auth.session,
  };
}

/**
 * The authenticated request as for authenticateRequest, or HttpError 403 when the member is not an
 * administrator.
 */
export async function requireAdmin(req) {
  const auth = await authenticateRequest(req);
  if (auth.profile.role !== 'admin') {
    throw new HttpError('Administrator access is required.', 403);
  }
  return auth;
}

/**
 * Making someone an administrator needs the same proof as other admin-panel
 * changes: an authenticator used in this session (aal2). Throws HttpError 403.
 */
export function assertAdminStepUp(req) {
  const { user, session } = req.auth ?? {};
  if (!user?.hasVerifiedFactor?.() || session?.aal !== 'aal2') {
    throw new HttpError(
      'Inviting an administrator needs your authenticator. Add one in Settings → Authenticator and sign in again.',
      403,
    );
  }
}
