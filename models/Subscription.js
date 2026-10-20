/**
 * A member's Premium membership: free trial, paid period (from Razorpay) and
 * any time an administrator granted by hand. One document per member, keyed by
 * user id. Whether the member has Premium right now is worked out from these
 * dates in services/billing/membership.js — never stored as a flag that could
 * go stale.
 */
import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema(
  {
    _id: String, // user id
    /** End of the free trial (set once, when the member is first seen with billing on). */
    trialEndsAt: { type: Date, default: null },
    /** When the "your trial ends soon" email was sent (once per trial). */
    trialReminderSentAt: { type: Date, default: null },
    /** End of the period already paid for (Razorpay current_end). */
    paidUntil: { type: Date, default: null },
    /** Premium given by an administrator until this date (offers, support, testers). */
    grantUntil: { type: Date, default: null },
    /** Razorpay subscription id and its last known status (created, authenticated, active, pending, halted, cancelled, completed). */
    razorpaySubscriptionId: { type: String, default: null },
    razorpayStatus: { type: String, default: null },
    /** Hosted payment page for a subscription the member has not paid for yet. */
    checkoutUrl: { type: String, default: null },
    /** Monthly price (₹) the subscription was created at; plans keep their price. */
    planPrice: { type: Number, default: null },
    /** The member cancelled: Premium continues until paidUntil, then stops. */
    cancelAtPeriodEnd: { type: Boolean, default: false },
  },
  { timestamps: true },
);
// Webhooks find the member by Razorpay subscription id.
subscriptionSchema.index(
  { razorpaySubscriptionId: 1 },
  { unique: true, partialFilterExpression: { razorpaySubscriptionId: { $type: 'string' } } },
);
// Admin overview counts by status.
subscriptionSchema.index({ razorpayStatus: 1 });

export const Subscription =
  mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
