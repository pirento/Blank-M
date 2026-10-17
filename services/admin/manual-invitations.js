/**
 * Private invitation links (no email needed): create, list and revoke them as
 * an administrator, and claim → finalize (or fail) one when a member accepts.
 *
 * Tokens are never stored, only their SHA-256 hash. Acceptance is two-step so a
 * half-finished activation is parked for administrator review instead of
 * reopening a one-use link.
 */
import { randomUUID } from 'node:crypto';
import {
  AllowedUser,
  MANUAL_INVITATION_TTL_MS,
  ManualInvitation,
  User,
} from '../../models/index.js';
import { reserveAttempts } from '../rate-window.js';

/**
 * A refused invitation operation. `forbidden` means the actor is not an active
 * administrator; every other refusal is a conflict the caller must review.
 */
export class InvitationRefusal extends Error {
  constructor(forbidden, message) {
    super(message);
    this.forbidden = forbidden;
  }
}
const isoString = (value) => (value ? new Date(value).toISOString() : null);

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
    throw new InvitationRefusal(true, 'An active administrator is required');
  }
}

/**
 * Creates a pending invitation (allow-list entry plus hashed-token row) that expires after
 * MANUAL_INVITATION_TTL_MS. Refuses when the identity already has an invitation, allow-list entry
 * or account.
 */
export async function createManualInvitation({ actorId, email, role, tokenHash }) {
  await requireAccessAdmin(actorId);
  if (!['member', 'admin'].includes(role) || !/^[a-f0-9]{64}$/.test(tokenHash ?? ''))
    throw new InvitationRefusal(false, 'Invalid invitation request');
  if (
    (await AllowedUser.exists({ _id: email })) ||
    (await ManualInvitation.exists({ email })) ||
    (await User.exists({ email }))
  )
    throw new InvitationRefusal(
      false,
      'This identity already has an invitation or membership; it cannot be replaced',
    );
  const now = new Date();
  await AllowedUser.create({ _id: email, role, invitedBy: actorId, invitedAt: now });
  const created = await ManualInvitation.create({
    email,
    role,
    tokenHash,
    invitedBy: actorId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + MANUAL_INVITATION_TTL_MS),
  });
  return {
    id: created._id,
    email: created.email,
    role: created.role,
    created_at: isoString(created.createdAt),
    expires_at: isoString(created.expiresAt),
    status: created.status,
  };
}

/**
 * Every invitation newest first, with status reported as revoked or expired when the allow-list
 * entry or expiry says so. Requires an active administrator.
 */
export async function listManualInvitations({ actorId }) {
  await requireAccessAdmin(actorId);
  const rows = await ManualInvitation.find().sort({ createdAt: -1, _id: 1 }).lean();
  const allowed = new Map(
    (await AllowedUser.find({ _id: { $in: rows.map((row) => row.email) } }).lean()).map((entry) => [
      entry._id,
      entry,
    ]),
  );
  const now = Date.now();
  return rows
    .filter((row) => allowed.has(row.email))
    .map((row) => {
      const entry = allowed.get(row.email);
      return {
        id: row._id,
        email: row.email,
        role: row.role,
        created_at: isoString(row.createdAt),
        expires_at: isoString(row.expiresAt),
        status: entry.revokedAt
          ? 'revoked'
          : ['pending', 'processing'].includes(row.status) && row.expiresAt.getTime() <= now
            ? 'expired'
            : row.status,
        consumed_at: isoString(row.consumedAt),
        revoked_at: isoString(row.revokedAt ?? entry.revokedAt),
      };
    });
}

/**
 * Revokes a not-yet-accepted invitation: marks its allow-list entry revoked, revokes any linked
 * account, and sets the row revoked. Refuses accepted invitations and entries whose role or account
 * no longer match.
 */
export async function revokeManualInvitation({ actorId, id }) {
  await requireAccessAdmin(actorId);
  const row = await ManualInvitation.findById(id);
  if (!row) throw new InvitationRefusal(false, 'Invitation not found');
  if (row.status === 'accepted')
    throw new InvitationRefusal(
      false,
      'Accepted membership must be revoked through member access controls',
    );
  const entry = await AllowedUser.findById(row.email);
  if (
    !entry ||
    entry.role !== row.role ||
    (entry.authUserId && entry.authUserId !== row.authUserId)
  )
    throw new InvitationRefusal(false, 'Invitation identity requires review');
  const now = new Date();
  entry.revokedAt ??= now;
  await entry.save();
  if (entry.authUserId)
    await User.updateOne({ _id: entry.authUserId }, { $set: { status: 'revoked' } });
  row.status = 'revoked';
  row.revokedAt ??= now;
  await row.save();
  return { id, status: 'revoked' };
}

/**
 * Reserves one acceptance attempt against a global (120/min) and per-client (5/min) rate window.
 * Returns `{ allowed: false }` for malformed hashes without touching the database.
 */
export async function reserveManualInvitationAttempt({ clientKey, tokenHash }) {
  if (!/^[a-f0-9]{64}$/.test(clientKey ?? '') || !/^[a-f0-9]{64}$/.test(tokenHash ?? ''))
    return { allowed: false };
  // Unknown tokens never allocate a token-specific persistent row.
  const quota = await reserveAttempts(
    [
      { key: 'manual-invite:global', limit: 120 },
      { key: `manual-invite:client:${clientKey}`, limit: 5 },
    ],
    60_000,
  );
  return { allowed: quota.allowed };
}

/**
 * Atomically moves a valid pending invitation to `processing`, minting the claim id and the new
 * account's user id. Throws one generic refusal for invalid, expired, used or conflicting tokens.
 */
export async function claimManualInvitation({ tokenHash }) {
  const invalid = () =>
    new InvitationRefusal(false, 'Invitation is invalid, expired or already used');
  if (!/^[a-f0-9]{64}$/.test(tokenHash ?? '')) throw invalid();
  const now = new Date();
  const pending = await ManualInvitation.findOne({ tokenHash: tokenHash }).lean();
  if (!pending || pending.status !== 'pending' || pending.expiresAt <= now) throw invalid();
  const entry = await AllowedUser.findById(pending.email).lean();
  if (!entry || entry.role !== pending.role || entry.revokedAt || entry.authUserId) throw invalid();
  if (await User.exists({ email: pending.email })) throw invalid();
  const claimed = await ManualInvitation.findOneAndUpdate(
    { _id: pending._id, status: 'pending' },
    {
      $set: {
        status: 'processing',
        claimId: randomUUID(),
        authUserId: randomUUID(),
        claimedAt: now,
      },
    },
    { new: true },
  ).lean();
  if (!claimed) throw invalid();
  return {
    id: claimed._id,
    email: claimed.email,
    role: claimed.role,
    claim_id: claimed.claimId,
    auth_user_id: claimed.authUserId,
    expires_at: isoString(claimed.expiresAt),
  };
}

/**
 * Activates the account created for a claimed invitation and marks the invitation accepted. Refuses
 * unless claim, allow-list entry and account (confirmed email, matching role, still revoked) all
 * line up and the grant has not expired.
 */
export async function finalizeManualInvitation({ id, claimId, userId }) {
  const row = await ManualInvitation.findById(id);
  const now = new Date();
  if (
    !row ||
    row.status !== 'processing' ||
    row.expiresAt <= now ||
    row.claimId !== claimId ||
    row.authUserId !== userId
  )
    throw new InvitationRefusal(
      false,
      'Invitation cannot be finalized; it requires administrator review',
    );
  const entry = await AllowedUser.findById(row.email);
  const account = await User.findById(userId);
  if (
    !entry ||
    entry.authUserId !== userId ||
    entry.revokedAt ||
    entry.role !== row.role ||
    !account ||
    account.email !== row.email ||
    !account.emailConfirmedAt ||
    account.manualInvitation?.id !== id ||
    account.manualInvitation?.claimId !== claimId ||
    account.role !== row.role ||
    account.status !== 'revoked'
  )
    throw new InvitationRefusal(false, 'Invitation identity or access could not be verified');
  // Recheck after every identity read; waiting cannot extend the 48-hour grant.
  if (row.expiresAt.getTime() <= Date.now())
    throw new InvitationRefusal(false, 'Invitation expired before activation');
  account.status = 'active';
  await account.save();
  entry.acceptedAt = account.emailConfirmedAt;
  await entry.save();
  row.status = 'accepted';
  row.consumedAt = new Date();
  await row.save();
  return { id, email: row.email, status: 'accepted' };
}

/**
 * Parks a still-processing claim as `needs_review` after a failed activation; never reopens the
 * token. Returns the row's resulting status.
 */
export async function failManualInvitation({ id, claimId }) {
  const row = await ManualInvitation.findById(id);
  if (!row || !claimId || row.claimId !== claimId)
    throw new InvitationRefusal(false, 'Invitation claim could not be verified');
  // Never reopen a token or overwrite committed acceptance/revocation.
  if (row.status === 'processing') {
    row.status = 'needs_review';
    await row.save();
  }
  return { id: row._id, status: row.status };
}
