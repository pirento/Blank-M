/**
 * Razorpay webhook events already processed, so a redelivered event is applied
 * only once. Kept for 90 days (Razorpay stops retrying long before that).
 */
import mongoose from 'mongoose';

const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

const billingEventSchema = new mongoose.Schema(
  {
    _id: String, // x-razorpay-event-id
    type: { type: String, default: '' },
    receivedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
billingEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: NINETY_DAYS_SECONDS });

export const BillingEvent =
  mongoose.models.BillingEvent || mongoose.model('BillingEvent', billingEventSchema);
