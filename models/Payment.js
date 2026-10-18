/**
 * Payments received through Razorpay (one document per Razorpay payment id),
 * written from webhooks. A financial record: kept, never expired.
 */
import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema(
  {
    _id: String, // Razorpay payment id (pay_…)
    userId: { type: String, default: null },
    razorpaySubscriptionId: { type: String, default: null },
    /** Amount in rupees (Razorpay sends paise). */
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    /** Razorpay payment status: captured, authorized, failed, refunded… */
    status: { type: String, required: true },
    method: { type: String, default: null },
    paidAt: { type: Date, required: true },
  },
  { timestamps: true },
);
// A member's payment history, newest first; revenue totals by date.
paymentSchema.index({ userId: 1, paidAt: -1 });
paymentSchema.index({ paidAt: -1 });

export const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
