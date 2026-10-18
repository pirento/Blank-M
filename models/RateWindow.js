/**
 * Durable fixed-window counters shared by every server process (login and
 * invitation quotas). Buckets are opaque hashes; no IP or identifier is stored.
 */
import mongoose from 'mongoose';

const rateWindowSchema = new mongoose.Schema({
  _id: String, // bucket key
  windowStartedAt: { type: Date, required: true },
  attempts: { type: Number, required: true, min: 0 },
  expiresAt: { type: Date, required: true },
});
// Retention: deleted as soon as the window ends.
rateWindowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateWindow =
  mongoose.models.RateWindow || mongoose.model('RateWindow', rateWindowSchema);
