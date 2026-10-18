/**
 * Single-use emailed links (invitation activation, password recovery) and the
 * one-time code an administrator needs to add their first authenticator.
 * Only a SHA-256 digest of the token is stored.
 */
import mongoose from 'mongoose';
import { uuidId } from './helpers.js';

const authTokenSchema = new mongoose.Schema({
  _id: uuidId,
  tokenHash: { type: String, required: true, unique: true },
  purpose: { type: String, enum: ['activate', 'recover', 'admin-mfa'], required: true },
  userId: { type: String, required: true },
  email: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
});
// Retention: kept 7 days past expiry, then deleted (used tokens are worthless after that).
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 86400 });
authTokenSchema.index({ userId: 1, purpose: 1 });

export const AuthToken = mongoose.models.AuthToken || mongoose.model('AuthToken', authTokenSchema);
