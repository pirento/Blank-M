/** Immutable client-computed research evidence, recomputed by the server before saving. */
import mongoose from 'mongoose';

const strategyEvidenceSchema = new mongoose.Schema(
  {
    _id: String,
    userId: { type: String, required: true },
    strategyId: { type: String, required: true },
    strategySnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    strategyHash: { type: String, required: true },
    evidence: { type: mongoose.Schema.Types.Mixed, required: true },
    evidenceHash: { type: String, required: true },
    serverRevision: { type: Number, required: true, unique: true },
    createdAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);
strategyEvidenceSchema.index({ userId: 1, serverRevision: -1 });

export const StrategyEvidence =
  mongoose.models.StrategyEvidence || mongoose.model('StrategyEvidence', strategyEvidenceSchema);

/** Append-only owner decisions. A decision never authorizes execution. */
const strategyEvidenceReviewSchema = new mongoose.Schema({
  _id: String,
  userId: { type: String, required: true },
  evidenceId: { type: String, required: true },
  decision: {
    type: String,
    enum: ['approved_research', 'changes_requested', 'revoked'],
    required: true,
  },
  notes: { type: String, required: true, minlength: 10, maxlength: 4000 },
  expectedReviewRevision: { type: Number, required: true, min: 0 },
  serverRevision: { type: Number, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
});
strategyEvidenceReviewSchema.index({ userId: 1, evidenceId: 1, serverRevision: -1 });

export const StrategyEvidenceReview =
  mongoose.models.StrategyEvidenceReview ||
  mongoose.model('StrategyEvidenceReview', strategyEvidenceReviewSchema);
