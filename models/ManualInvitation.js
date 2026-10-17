/** Private, single-use invitation links that send no email. */
import mongoose from 'mongoose';
import { uuidId } from './helpers.js';

export const MANUAL_INVITATION_TTL_MS = 48 * 60 * 60_000;

const manualInvitationSchema = new mongoose.Schema({
  _id: uuidId,
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  role: { type: String, enum: ['admin', 'member'], required: true },
  tokenHash: { type: String, required: true, unique: true, match: /^[a-f0-9]{64}$/ },
  invitedBy: { type: String, required: true },
  createdAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'accepted', 'revoked', 'needs_review'],
    default: 'pending',
  },
  claimId: { type: String, default: null },
  authUserId: { type: String, default: null },
  claimedAt: { type: Date, default: null },
  consumedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
});

export const ManualInvitation =
  mongoose.models.ManualInvitation || mongoose.model('ManualInvitation', manualInvitationSchema);
