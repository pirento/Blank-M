/**
 * A written trading strategy (name, rules, improvements and notes) dated to the
 * day it was recorded.
 */
import mongoose from 'mongoose';
import { timestamps, uuidId } from './helpers.js';

const strategySchema = new mongoose.Schema(
  {
    _id: uuidId,
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true, minlength: 1, maxlength: 120 },
    rules: { type: String, default: '' },
    improvements: { type: String, default: '' },
    notes: { type: String, default: '' },
    /** Calendar date, YYYY-MM-DD. */
    tradeDate: { type: String, required: true },
    /** shared/strategy-stages.js: draft → backtested → paper → live → retired. */
    stage: {
      type: String,
      enum: ['draft', 'backtested', 'paper', 'live', 'retired'],
      default: 'draft',
    },
    /** Every stage change, oldest first (at most 50). */
    stageHistory: {
      type: [{ _id: false, stage: String, at: Date, note: String }],
      default: [],
    },
  },
  timestamps,
);
strategySchema.index({ userId: 1, tradeDate: -1, _id: -1 });

export const Strategy = mongoose.models.Strategy || mongoose.model('Strategy', strategySchema);
