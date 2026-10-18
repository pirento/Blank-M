/** Durable, owner-scoped research archive. One request ID owns one provider call. */
import mongoose from 'mongoose';
import { uuidId } from './helpers.js';

const researchRunSchema = new mongoose.Schema(
  {
    _id: uuidId,
    userId: { type: String, required: true },
    requestId: { type: String, required: true },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    outcome: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    inputs: { type: mongoose.Schema.Types.Mixed, required: true },
    universe: { type: mongoose.Schema.Types.Mixed, required: true },
    picks: { type: mongoose.Schema.Types.Mixed, default: [] },
    sources: { type: mongoose.Schema.Types.Mixed, default: [] },
    /** Monotonic order for keyset pagination. */
    sequence: { type: Number, required: true },
  },
  { minimize: false },
);
researchRunSchema.index({ userId: 1, requestId: 1 }, { unique: true });
researchRunSchema.index({ userId: 1, sequence: -1 });
// Retention: each run keeps a full NIFTY 500 universe snapshot (~60 KB), so runs are deleted 180
// days after they started. Nothing replays a request ID that old.
researchRunSchema.index({ startedAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export const ResearchRun =
  mongoose.models.ResearchRun || mongoose.model('ResearchRun', researchRunSchema);
