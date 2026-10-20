/**
 * How many times a free member used a Premium feature this month (IST), for the
 * free monthly allowance the administrator sets per feature. One row per
 * member, feature and month; rows expire two months after their month.
 */
import mongoose from 'mongoose';

const usageCounterSchema = new mongoose.Schema(
  {
    _id: String, // `${userId}:${feature}:${YYYY-MM}`
    userId: { type: String, required: true },
    feature: { type: String, required: true },
    month: { type: String, required: true },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);
usageCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
usageCounterSchema.index({ userId: 1, month: 1 });

export const UsageCounter =
  mongoose.models.UsageCounter || mongoose.model('UsageCounter', usageCounterSchema);
