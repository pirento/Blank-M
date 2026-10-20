/**
 * One free trial per person: a digest of the canonical email (see
 * services/billing/membership.js) recorded when a trial starts. Kept after the
 * account is deleted, so re-signing up, or using Gmail dots and "+tags", does
 * not give a second trial. Only the digest is stored, never the address.
 */
import mongoose from 'mongoose';

const trialClaimSchema = new mongoose.Schema(
  {
    _id: String, // sha256 of the canonical email
    userId: { type: String, required: true },
    claimedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

export const TrialClaim =
  mongoose.models.TrialClaim || mongoose.model('TrialClaim', trialClaimSchema);
