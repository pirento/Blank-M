/** Append-only cloud copies of browser planning records. Never an order or a trade. */
import mongoose from 'mongoose';

const orderPlanRecordSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    recordKey: { type: String, required: true },
    recordKind: { type: String, enum: ['plan', 'review', 'removed'], required: true },
    record: { type: mongoose.Schema.Types.Mixed, required: true },
    serverRevision: { type: Number, required: true, unique: true },
  },
  { minimize: false },
);
orderPlanRecordSchema.index({ userId: 1, recordKey: 1 }, { unique: true });
orderPlanRecordSchema.index({ userId: 1, serverRevision: 1 });

export const OrderPlanRecord =
  mongoose.models.OrderPlanRecord || mongoose.model('OrderPlanRecord', orderPlanRecordSchema);
