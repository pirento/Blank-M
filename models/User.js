/**
 * A member account: email, password hash, role and status, encrypted
 * authenticator secrets and the private-invitation claim.
 */
import mongoose from 'mongoose';
import { timestamps, uuidId } from './helpers.js';

const factorSchema = new mongoose.Schema(
  {
    _id: uuidId,
    factorType: { type: String, enum: ['totp'], default: 'totp' },
    friendlyName: { type: String, maxlength: 120, default: '' },
    status: { type: String, enum: ['verified', 'unverified'], default: 'unverified' },
    /** AES-256-GCM encrypted base32 secret. */
    secret: { ciphertext: String, iv: String, tag: String },
    /** Last accepted time step, so one code cannot be replayed. */
    lastUsedStep: { type: Number, default: null },
    createdAt: { type: Date, default: Date.now },
    verifiedAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * Identity and workspace profile in one document. Access is granted only through an invitation allowlist row.
 */
const userSchema = new mongoose.Schema(
  {
    _id: uuidId,
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, default: null },
    displayName: { type: String, maxlength: 120, default: null },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    emailConfirmedAt: { type: Date, default: null },
    lastSignInAt: { type: Date, default: null },
    bannedUntil: { type: Date, default: null },
    googleSubject: { type: String, default: null },
    factors: { type: [factorSchema], default: [] },
    manualInvitation: {
      id: { type: String, default: null },
      claimId: { type: String, default: null },
    },
  },
  timestamps,
);
userSchema.index(
  { googleSubject: 1 },
  { unique: true, partialFilterExpression: { googleSubject: { $type: 'string' } } },
);
// New members per day and the activity feed on the admin overview.
userSchema.index({ createdAt: -1 });

userSchema.methods.hasVerifiedFactor = function hasVerifiedFactor() {
  return this.factors.some((factor) => factor.status === 'verified');
};

export const User = mongoose.models.User || mongoose.model('User', userSchema);
