/**
 * A read-only link to a member's journal for a mentor. Only a SHA-256 digest
 * of the token is stored; the link expires and can be revoked.
 */
import mongoose from 'mongoose';
import { timestamps, uuidId } from './helpers.js';

const shareLinkSchema = new mongoose.Schema(
  {
    _id: uuidId,
    userId: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    label: { type: String, default: '' },
    /** Trade notes are private reflections; shared only when the member chooses. */
    includeNotes: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    lastViewedAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0 },
  },
  timestamps,
);
shareLinkSchema.index({ userId: 1, createdAt: -1 });

export const ShareLink = mongoose.models.ShareLink || mongoose.model('ShareLink', shareLinkSchema);
