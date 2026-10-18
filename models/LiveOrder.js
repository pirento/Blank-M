/**
 * Audit log of live broker orders placed from saved plans. A plan can have at most
 * one order that was placed, is being placed or has an unknown outcome; rejected
 * attempts stay in the log and the plan may be sent again.
 */
import mongoose from 'mongoose';

const liveOrderSchema = new mongoose.Schema(
  {
    _id: String, // client idempotency key (UUID)
    userId: { type: String, required: true },
    planId: { type: String, required: true },
    status: { type: String, enum: ['submitting', 'placed', 'rejected', 'unknown'], required: true },
    symbol: { type: String, required: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    product: { type: String, enum: ['MIS', 'CNC'], required: true },
    quantity: { type: Number, required: true },
    price: { type: String, required: true },
    orderValue: { type: Number, required: true },
    referencePrice: { type: Number, default: null },
    brokerOrderId: { type: String, default: null },
    error: { type: String, default: null },
    tradingDate: { type: String, required: true },
    /** Place the stop-loss/target GTT automatically once the entry fills (CNC buys only). */
    autoGtt: { type: Boolean, default: false },
    /** Stop-loss/target GTT placed after the entry filled (CNC only). */
    gttStatus: { type: String, enum: ['placed', 'rejected', 'unknown', null], default: null },
    gttTriggerId: { type: String, default: null },
    gttStop: { type: Number, default: null },
    gttTarget: { type: Number, default: null },
    gttError: { type: String, default: null },
  },
  { timestamps: true },
);
liveOrderSchema.index(
  { userId: 1, planId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['submitting', 'placed', 'unknown'] } },
  },
);
liveOrderSchema.index({ userId: 1, tradingDate: 1 });

export const LiveOrder = mongoose.models.LiveOrder || mongoose.model('LiveOrder', liveOrderSchema);
