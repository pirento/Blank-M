/** A saved AI coach review of one day or week of the member's trading. */
import mongoose from 'mongoose';
import { timestamps, uuidId } from './helpers.js';

const coachReviewSchema = new mongoose.Schema(
  {
    _id: uuidId,
    userId: { type: String, required: true },
    period: { type: String, enum: ['day', 'week'], required: true },
    /** First and last IST date covered. */
    from: { type: String, required: true },
    to: { type: String, required: true },
    tradeCount: { type: Number, default: 0 },
    review: { type: mongoose.Schema.Types.Mixed, required: true },
    model: { type: String, default: '' },
  },
  timestamps,
);
coachReviewSchema.index({ userId: 1, createdAt: -1 });
coachReviewSchema.index({ userId: 1, period: 1, to: -1 });

export const CoachReview =
  mongoose.models.CoachReview || mongoose.model('CoachReview', coachReviewSchema);
