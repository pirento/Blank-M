/**
 * HTTP handlers for private invitation links. The data rules live in
 * services/admin/manual-invitations.js; this file validates input, maps refusals to
 * responses and keeps every response uncacheable.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { clientAddress, readJsonBody, requireMethod } from '../services/http.js';
import { requireAdmin } from '../services/auth/request-auth.js';
import { AllowedUser, User } from '../models/index.js';
import { hashPassword } from '../services/auth/accounts.js';
import {
  InvitationRefusal,
  claimManualInvitation,
  createManualInvitation,
  failManualInvitation,
  finalizeManualInvitation,
  listManualInvitations,
  reserveManualInvitationAttempt,
  revokeManualInvitation,
} from '../services/admin/manual-invitations.js';
import { AdminContractError } from '../services/admin/contracts.js';
import { manualInvitationSchema } from '../shared/manual-invitations.js';

const email = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((value) => value.toLowerCase());
const acceptSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(12).max(128),
  })
  .strict();
const NOT_AVAILABLE = 'This invitation is invalid, expired, revoked, or already used.';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
function headers(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
function failure(res, error, anonymous = false) {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: anonymous
        ? 'Use a valid invitation and a password of 12 to 128 characters.'
        : 'Enter a valid invitation email and role.',
    });
    return;
  }
  const code =
    error instanceof AdminContractError
      ? error.status
      : typeof error === 'object' &&
          error !== null &&
          'status' in error &&
          [401, 403, 429].includes(Number(error.status))
        ? Number(error.status)
        : 503;
  res.status(code).json({
    error:
      error instanceof AdminContractError || code === 401 || code === 403
        ? error.message
        : 'The invitation service is unavailable. No successful access change is confirmed.',
  });
}
/**
 * Run one invitation store operation and turn its refusals into the messages
 * the admin screen (or, for `anonymous`, the public accept page) shows.
 */
async function run(operation, anonymous = false) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminContractError) throw error;
    if (error instanceof InvitationRefusal) {
      if (error.forbidden)
        throw new AdminContractError(
          anonymous ? NOT_AVAILABLE : 'Administrator access is required.',
          403,
        );
      throw new AdminContractError(
        anonymous
          ? NOT_AVAILABLE
          : 'The invitation operation was refused. Refresh the list and review the existing identity.',
        409,
      );
    }
    throw new AdminContractError('The invitation database contract is unavailable.');
  }
}
function publicInvitation(value) {
  return manualInvitationSchema.parse({
    id: value.id,
    email: value.email,
    role: value.role,
    createdAt: value.created_at,
    expiresAt: value.expires_at,
    status: value.status,
    consumedAt: value.consumed_at ?? null,
    revokedAt: value.revoked_at ?? null,
  });
}
function invitationOrigin() {
  let origin;
  try {
    origin = new URL(process.env.APP_URL || '');
  } catch {
    throw new AdminContractError(
      'APP_URL must be configured before creating a private invitation link.',
    );
  }
  const local =
    origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    (!local && origin.protocol !== 'https:') ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/'
  ) {
    throw new AdminContractError(
      'APP_URL must be an HTTPS application origin before creating private invitation links.',
    );
  }
  return origin;
}

/**
 * POST /api/admin/manual-invitations { email, role? }: creates a 48-hour invitation and returns
 * its one-time /invite link (201). Nothing is emailed; requires an HTTPS APP_URL.
 */
export async function handleCreateManualInvitation(req, res) {
  headers(res);
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const admin = await requireAdmin(req);
    const input = z
      .object({ email, role: z.enum(['member', 'admin']).default('member') })
      .strict()
      .parse(readJsonBody(req));
    const origin = invitationOrigin();
    const token = randomBytes(32).toString('base64url');
    const created = await run(() =>
      createManualInvitation({
        actorId: admin.user.id,
        email: input.email,
        role: input.role,
        tokenHash: digest(token),
      }),
    );
    if (
      created.email !== input.email ||
      created.role !== input.role ||
      created.status !== 'pending' ||
      Date.parse(created.expires_at) - Date.parse(created.created_at) !== 48 * 60 * 60_000
    ) {
      throw new AdminContractError(
        'The newly created invitation could not be verified. Review invitations before retrying.',
      );
    }
    const url = new URL('/invite', origin);
    url.hash = `token=${token}`;
    res
      .status(201)
      .json({ invitation: publicInvitation(created), url: url.toString(), emailSent: false });
  } catch (error) {
    failure(res, error);
  }
}

/** GET lists invitations; any other method creates one. */
export function handleManualInvitations(req, res) {
  return (req.method ?? 'GET').toUpperCase() === 'GET'
    ? handleListManualInvitations(req, res)
    : handleCreateManualInvitation(req, res);
}

/** GET /api/admin/manual-invitations: the manual invitations (administrators only). */
export async function handleListManualInvitations(req, res) {
  headers(res);
  if (!requireMethod(req, res, 'GET')) return;
  try {
    const admin = await requireAdmin(req);
    const invitations = await run(() => listManualInvitations({ actorId: admin.user.id }));
    res.status(200).json({ invitations: invitations.map(publicInvitation) });
  } catch (error) {
    failure(res, error);
  }
}

/**
 * POST /api/admin/manual-invitations/revoke { id }: revokes a manual invitation (administrators
 * only).
 */
export async function handleRevokeManualInvitation(req, res) {
  headers(res);
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const admin = await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(readJsonBody(req));
    const result = await run(() => revokeManualInvitation({ actorId: admin.user.id, id }));
    if (result.id !== id)
      throw new AdminContractError('The invitation revocation could not be verified.');
    res.status(200).json({ ok: true });
  } catch (error) {
    failure(res, error);
  }
}

/**
 * POST /api/invitations/accept { token, password }: creates the invited account. Rate-limited per
 * client; once claimed, a failure parks the invitation for administrator review (503).
 */
export async function handleAcceptManualInvitation(req, res) {
  headers(res);
  if (!requireMethod(req, res, 'POST')) return;
  let claim = null;
  try {
    const input = acceptSchema.parse(readJsonBody(req));
    const hash = digest(input.token);
    // The proxy-reported client address (see clientAddress); a global cap
    // also applies across all clients.
    const quota = await run(
      () =>
        reserveManualInvitationAttempt({
          clientKey: digest(clientAddress(req)),
          tokenHash: hash,
        }),
      true,
    );
    if (!quota.allowed) {
      res.setHeader('Retry-After', '60');
      throw new AdminContractError(
        'Too many invitation attempts. Wait a minute and try again.',
        429,
      );
    }
    claim = await run(() => claimManualInvitation({ tokenHash: hash }), true);
    if (Date.parse(claim.expires_at) <= Date.now())
      throw new AdminContractError(NOT_AVAILABLE, 409);
    // The provisional account stays blocked until finalization rechecks the
    // claim, identity, expiry and revocation.
    let created;
    try {
      created = await User.create({
        _id: claim.auth_user_id,
        email: claim.email,
        passwordHash: await hashPassword(input.password),
        role: claim.role,
        status: 'revoked',
        emailConfirmedAt: new Date(),
        manualInvitation: { id: claim.id, claimId: claim.claim_id },
      });
      await AllowedUser.updateOne(
        { _id: claim.email, authUserId: null },
        { $set: { authUserId: claim.auth_user_id } },
      );
    } catch {
      throw new AdminContractError('The invited identity could not be provisioned.');
    }
    if (created._id !== claim.auth_user_id || created.email !== claim.email) {
      throw new AdminContractError('The invited identity could not be verified.');
    }
    const result = await run(
      () =>
        finalizeManualInvitation({
          id: claim.id,
          claimId: claim.claim_id,
          userId: claim.auth_user_id,
        }),
      true,
    );
    if (result.id !== claim.id || result.email !== claim.email)
      throw new AdminContractError('The invitation acceptance could not be verified.');
    res.status(200).json({ accepted: true, email: result.email });
  } catch (error) {
    if (claim) {
      // Never delete an uncertain identity, retry creation, or reopen a
      // one-use token after partial work: park the claim for review instead.
      try {
        await failManualInvitation({ id: claim.id, claimId: claim.claim_id });
      } catch {
        /* The durable claimed state already blocks another acceptance. */
      }
      res.status(503).json({
        error:
          'Membership activation could not be confirmed. This invitation requires administrator review; do not reuse the link.',
        requiresReview: true,
      });
      return;
    }
    failure(res, error, true);
  }
}
