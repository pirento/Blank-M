/**
 * Administrator member management: list members, invite by email, resend an
 * invitation, create a password reset link and revoke access.
 */
import { z } from 'zod';
import { readJsonBody, requireMethod } from '../services/http.js';
import { assertAdminStepUp, requireAdmin } from '../services/auth/request-auth.js';
import { AdminContractError } from '../services/admin/contracts.js';
import { AllowedUser, ManualInvitation, User } from '../models/index.js';
import {
  accessProblem,
  createRecoveryLink,
  revokeUserSessions,
  sendActivationEmail,
} from '../services/auth/accounts.js';
import { reserveAttempts } from '../services/rate-window.js';
import { endSubscriptionNow } from '../services/billing/subscriptions.js';
import { detachRevokedMember } from '../services/admin/delete-member.js';
import { iso } from '../models/helpers.js';
import { createLogger, errorName } from '../services/logger.js';

const log = createLogger('admin');

const emailSchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((value) => value.toLowerCase());
const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(['admin', 'member']).default('member'),
});
const emailBodySchema = z.object({ email: emailSchema });
const revokeSchema = z.object({
  userId: z.string().uuid().nullable().optional(),
  email: emailSchema,
});
const FAR_FUTURE = new Date('2126-01-01T00:00:00.000Z');

function failure(res, error) {
  const candidate =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number(error.status)
      : error instanceof z.ZodError
        ? 400
        : 500;
  const status =
    Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  const message =
    status === 429
      ? 'Email delivery is temporarily rate-limited. Try again in a few minutes.'
      : (status < 500 || error instanceof AdminContractError || error?.name === 'HttpError') &&
          error instanceof Error
        ? error.message
        : 'The administrator request could not be completed.';
  if (status >= 500) log.error('request failed', { status, error: errorName(error) });
  res.status(status).json({ error: message });
}

/** The actor must still be an active, non-revoked administrator. */
async function requireAccessAdmin(actorId) {
  const actor = await User.findById(actorId).lean();
  const invitation = actor ? await AllowedUser.findOne({ authUserId: actorId }).lean() : null;
  if (
    !actor ||
    actor.role !== 'admin' ||
    actor.status !== 'active' ||
    !invitation ||
    invitation.revokedAt ||
    (actor.bannedUntil && actor.bannedUntil > new Date())
  ) {
    throw new AdminContractError('An active administrator is required', 403);
  }
}

/**
 * GET /api/admin/users: every email invitation with its account status. Pending manual
 * invitations are left out. Needs an active, non-revoked administrator.
 */
export async function handleListUsers(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  try {
    const admin = await requireAdmin(req);
    await requireAccessAdmin(admin.user.id);
    // Manual invitations own their provisional identities until accepted.
    const manual = await ManualInvitation.find(
      { status: { $ne: 'accepted' } },
      { email: 1 },
    ).lean();
    const hidden = new Set(manual.map((row) => row.email));
    const invitations = await AllowedUser.find().sort({ invitedAt: -1, _id: 1 }).lean();
    const accounts = await User.find({
      _id: { $in: invitations.map((row) => row.authUserId).filter(Boolean) },
    }).lean();
    const byId = new Map(accounts.map((account) => [account._id, account]));
    const users = invitations
      .filter((entry) => !hidden.has(entry._id))
      .map((entry) => {
        const account = entry.authUserId ? byId.get(entry.authUserId) : null;
        const profileStatus = account?.status ?? null;
        const confirmedAt = account?.emailConfirmedAt ?? null;
        const revoked = Boolean(entry.revokedAt || profileStatus === 'revoked');
        return {
          email: entry._id,
          role: account?.role ?? entry.role,
          invitationRole: entry.role,
          userId: entry.authUserId ?? null,
          invitedAt: iso(entry.invitedAt),
          acceptedAt: iso(confirmedAt),
          revokedAt: iso(entry.revokedAt),
          lastSignInAt: iso(account?.lastSignInAt),
          accessStatus: profileStatus ?? 'not_created',
          status: revoked
            ? 'revoked'
            : confirmedAt && profileStatus === 'active'
              ? 'active'
              : 'invited',
          authBanPending:
            revoked &&
            entry.authUserId !== null &&
            !(account?.bannedUntil && account.bannedUntil.getTime() > Date.now()),
        };
      });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ users });
  } catch (error) {
    failure(res, error);
  }
}

/**
 * Create the allowlist row and an unconfirmed account, or re-send an existing
 * unconfirmed invitation. The emailed link lets the invitee choose a password.
 */
async function requestInvitation(email, role, actorId, isResend) {
  if (!process.env.APP_URL) throw new AdminContractError('APP_URL is not configured.');
  await requireAccessAdmin(actorId);
  if (await ManualInvitation.exists({ email })) {
    throw new AdminContractError(
      'This address uses a manual invitation; email invitation cannot replace it',
      409,
    );
  }
  let invitation = await AllowedUser.findById(email);
  let account = invitation?.authUserId ? await User.findById(invitation.authUserId) : null;
  if (!invitation) {
    if (isResend) throw new AdminContractError('Invitation not found', 404);
    if (await User.exists({ email })) {
      throw new AdminContractError('Invitation identity requires review', 409);
    }
    account = await User.create({ email, role, status: 'active' });
    invitation = await AllowedUser.create({
      _id: email,
      role,
      invitedBy: actorId,
      invitedAt: new Date(),
      authUserId: account._id,
    });
  } else {
    if (
      invitation.revokedAt ||
      account?.status === 'revoked' ||
      (account?.bannedUntil && account.bannedUntil > new Date())
    ) {
      throw new AdminContractError('Revoked identities cannot be invited or resent', 409);
    }
    if (account && account.email !== email) {
      throw new AdminContractError('Invitation email changed and requires manual review', 409);
    }
    if (account?.emailConfirmedAt) {
      throw new AdminContractError('Confirmed identities cannot be invited or resent', 409);
    }
    if (
      (role !== null && role !== invitation.role) ||
      (account && account.role !== invitation.role)
    ) {
      throw new AdminContractError(
        'Invitation role changes require a separate reviewed operation',
        409,
      );
    }
    if (!account) {
      account = await User.create({ email, role: invitation.role, status: 'active' });
      invitation.authUserId = account._id;
      await invitation.save();
    }
  }
  await sendActivationEmail(account);
}

/**
 * POST /api/admin/users/invite { email, role? }: creates the invitation and emails an activation
 * link (201).
 */
export async function handleInviteUser(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const admin = await requireAdmin(req);
    const body = inviteSchema.parse(readJsonBody(req));
    if (body.role === 'admin') assertAdminStepUp(req);
    await requestInvitation(body.email, body.role, admin.user.id, false);
    res.status(201).json({ ok: true, invitationStatus: 'requested', deliveryConfirmed: false });
  } catch (error) {
    failure(res, error);
  }
}

/**
 * POST /api/admin/users/resend { email }: re-sends an unconfirmed invitation (404 when none
 * exists).
 */
export async function handleResendInvite(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const admin = await requireAdmin(req);
    const body = emailBodySchema.parse(readJsonBody(req));
    await requestInvitation(body.email, null, admin.user.id, true);
    res.status(200).json({ ok: true, invitationStatus: 'requested', deliveryConfirmed: false });
  } catch (error) {
    failure(res, error);
  }
}

/**
 * One-hour password reset link for an active member, shared by the administrator
 * out of band. Works without email delivery; the link is returned once.
 */
export async function handleCreateResetLink(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const admin = await requireAdmin(req);
    // A reset link takes over a member's account: a stolen admin password alone must not do it.
    assertAdminStepUp(req);
    await requireAccessAdmin(admin.user.id);
    const body = emailBodySchema.parse(readJsonBody(req));
    const quota = await reserveAttempts(
      [{ key: `admin-reset:${admin.user.id}`, limit: 20 }],
      60 * 60_000,
    );
    if (!quota.allowed) {
      throw new AdminContractError('Too many reset links requested. Try again later.', 400);
    }
    const user = await User.findOne({ email: body.email });
    if (
      !user ||
      user.role === 'admin' ||
      !user.emailConfirmedAt ||
      !user.passwordHash ||
      (await accessProblem(user))
    ) {
      throw new AdminContractError(
        'Reset links are available only for members with active, activated access.',
        409,
      );
    }
    const link = await createRecoveryLink(user);
    res.status(201).json({ ...link, email: user.email, emailSent: false });
  } catch (error) {
    failure(res, error);
  }
}

/**
 * POST /api/admin/users/revoke { email, userId? }: revokes workspace access, then bans the account
 * and ends its sessions. Answers 502 (retryable) when only the ban step failed.
 */
export async function handleRevokeUser(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const admin = await requireAdmin(req);
    assertAdminStepUp(req);
    const body = revokeSchema.parse(readJsonBody(req));
    if (body.userId === admin.user.id) {
      throw new AdminContractError('You cannot revoke your own administrator account.', 400);
    }
    await requireAccessAdmin(admin.user.id);
    const invitation = await AllowedUser.findById(body.email);
    if (!invitation) throw new AdminContractError('Invitation not found', 404);
    if (body.userId && body.userId !== invitation.authUserId) {
      throw new AdminContractError('Expected user does not match invitation identity', 409);
    }
    if (invitation.authUserId === admin.user.id) {
      throw new AdminContractError('You cannot revoke your own access', 409);
    }
    invitation.revokedAt ??= new Date();
    await invitation.save();
    // Workspace access is revoked first; the account ban and session removal follow.
    if (invitation.authUserId) {
      try {
        await User.updateOne(
          { _id: invitation.authUserId },
          { $set: { status: 'revoked', bannedUntil: FAR_FUTURE } },
        );
        await revokeUserSessions(invitation.authUserId);
        // A revoked member can no longer cancel, so stop their Razorpay renewals here.
        await endSubscriptionNow(invitation.authUserId).catch((error) =>
          log.error('subscription not cancelled after revoke', { error: errorName(error) }),
        );
        // Stop background work for them too (broker quotes, push and Telegram alerts).
        await detachRevokedMember(invitation.authUserId);
      } catch {
        log.error('sign-in ban incomplete after workspace revocation');
        res.status(502).json({
          error:
            'Workspace access is revoked, but the Auth ban failed. Retry revoke to finish the Auth ban.',
          workspaceAccessRevoked: true,
          authBanStatus: 'pending',
          retryable: true,
        });
        return;
      }
    }
    res.status(200).json({
      ok: true,
      workspaceAccessRevoked: true,
      authBanStatus: invitation.authUserId ? 'complete' : 'not_required',
    });
  } catch (error) {
    failure(res, error);
  }
}
