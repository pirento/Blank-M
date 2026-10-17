/**
 * A trading rule in the member's rule book, grouped by section and ordered.
 */
import mongoose from 'mongoose';
import { timestamps, uuidId } from './helpers.js';

const tradingRuleSchema = new mongoose.Schema(
  {
    _id: uuidId,
    userId: { type: String, required: true },
    section: { type: String, required: true, minlength: 1, maxlength: 120 },
    definition: { type: String, default: '' },
    rule: { type: String, required: true, minlength: 1, maxlength: 4000 },
    position: { type: Number, default: 0, min: 0 },
  },
  timestamps,
);
tradingRuleSchema.index({ userId: 1, createdAt: 1, _id: 1 });

export const TradingRule =
  mongoose.models.TradingRule || mongoose.model('TradingRule', tradingRuleSchema);
