/** A browser's Web Push subscription for one member (one row per device/browser). */
import mongoose from 'mongoose';
import { timestamps, uuidId } from './helpers.js';

const pushSubscriptionSchema = new mongoose.Schema(
  {
    _id: uuidId,
    userId: { type: String, required: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, default: '' },
  },
  timestamps,
);
pushSubscriptionSchema.index({ userId: 1 });

export const PushSubscription =
  mongoose.models.PushSubscription || mongoose.model('PushSubscription', pushSubscriptionSchema);
