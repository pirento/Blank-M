/** A price alert on an instrument: fires once when the price crosses the level. */
import mongoose from 'mongoose';
import { timestamps, uuidId } from './helpers.js';

const priceAlertSchema = new mongoose.Schema(
  {
    _id: uuidId,
    userId: { type: String, required: true },
    symbol: { type: String, required: true },
    /** 'above': fires when the price is at or above `price`; 'below': at or below. */
    condition: { type: String, enum: ['above', 'below'], required: true },
    price: { type: Number, required: true, min: 0.01 },
    note: { type: String, default: '' },
    status: { type: String, enum: ['active', 'triggered'], default: 'active' },
    channels: {
      email: { type: Boolean, default: false },
      push: { type: Boolean, default: true },
    },
    triggeredAt: { type: Date, default: null },
    triggeredPrice: { type: Number, default: null },
  },
  timestamps,
);
priceAlertSchema.index({ userId: 1, status: 1, createdAt: -1 });
priceAlertSchema.index({ status: 1 });
// Retention: a triggered alert is deleted 90 days after it fired (active alerts have no
// triggeredAt, and re-arming clears it, so they are never removed).
priceAlertSchema.index({ triggeredAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const PriceAlert =
  mongoose.models.PriceAlert || mongoose.model('PriceAlert', priceAlertSchema);
