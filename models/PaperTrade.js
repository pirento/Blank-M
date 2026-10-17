/**
 * A simulated trade: entered at a live quote without sending an order, then
 * closed by its stop, its target or the member. Kept apart from the journal.
 */
import mongoose from 'mongoose';
import { timestamps, uuidId } from './helpers.js';

const paperTradeSchema = new mongoose.Schema(
  {
    _id: uuidId,
    userId: { type: String, required: true },
    /** The order plan it was started from, if any. */
    planId: { type: String, default: null },
    symbol: { type: String, required: true },
    direction: { type: String, enum: ['Long', 'Short'], required: true },
    quantity: { type: Number, required: true, min: 1 },
    entryPrice: { type: Number, required: true },
    stopLoss: { type: Number, default: null },
    takeProfit: { type: Number, default: null },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    openedAt: { type: Date, default: () => new Date() },
    /** Latest observed price and when it was read. */
    lastPrice: { type: Number, default: null },
    lastPriceAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    exitPrice: { type: Number, default: null },
    exitReason: { type: String, enum: ['stop', 'target', 'manual', null], default: null },
    grossPnl: { type: Number, default: null },
    charges: { type: Number, default: null },
    netPnl: { type: Number, default: null },
  },
  timestamps,
);
paperTradeSchema.index({ userId: 1, status: 1, openedAt: -1 });
paperTradeSchema.index({ status: 1 });

export const PaperTrade =
  mongoose.models.PaperTrade || mongoose.model('PaperTrade', paperTradeSchema);
