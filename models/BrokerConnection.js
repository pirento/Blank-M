/** Encrypted broker access token, bound to one broker identity per account. */
import mongoose from 'mongoose';
import { BROKER_PROVIDERS } from '../shared/broker-portfolio.js';

const brokerConnectionSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    provider: { type: String, enum: BROKER_PROVIDERS, default: 'kite' },
    accessTokenCiphertext: { type: String, default: '' },
    accessTokenIv: { type: String, default: '' },
    accessTokenTag: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
    brokerUserId: { type: String, default: null },
    connectedAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' } },
);
brokerConnectionSchema.index({ userId: 1, provider: 1 }, { unique: true });

export const BrokerConnection =
  mongoose.models.BrokerConnection || mongoose.model('BrokerConnection', brokerConnectionSchema);

/** Single-use OAuth markers bound to an account, app session and browser. */
const brokerOAuthStateSchema = new mongoose.Schema({
  _id: String, // state hash
  userId: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
// Retention: login markers are deleted one day after they expire.
brokerOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

export const BrokerOAuthState =
  mongoose.models.BrokerOAuthState || mongoose.model('BrokerOAuthState', brokerOAuthStateSchema);
