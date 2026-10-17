/**
 * AI models: usage events (for rate limits), the model configuration and journal
 * search embeddings.
 */
import mongoose from 'mongoose';

/** Usage metadata only. Prompts are never recorded here. */
const aiUsageEventSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  feature: { type: String, required: true },
  model: { type: String, required: true },
  status: { type: String, required: true },
  inputTokens: { type: Number, default: null },
  outputTokens: { type: Number, default: null },
  requestId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});
aiUsageEventSchema.index({ userId: 1, createdAt: -1 });
// Limits look back one hour; keep 90 days of usage history, then let MongoDB delete it.
aiUsageEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const AiUsageEvent =
  mongoose.models.AiUsageEvent || mongoose.model('AiUsageEvent', aiUsageEventSchema);

/** Singleton routing configuration managed by administrators. */
const aiConfigurationSchema = new mongoose.Schema(
  {
    _id: { type: Number, default: 1 },
    analysisModel: { type: String, required: true },
    fastModel: { type: String, required: true },
    updatedBy: { type: String, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' } },
);

export const AiConfiguration =
  mongoose.models.AiConfiguration || mongoose.model('AiConfiguration', aiConfigurationSchema);

/** Semantic-search vectors for the owner's journal; similarity is computed in-process. */
const journalEmbeddingSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    sourceType: { type: String, enum: ['trade', 'strategy', 'rule', 'chat'], required: true },
    sourceId: { type: String, required: true },
    contentHash: { type: String, required: true },
    embedding: { type: [Number], required: true },
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' } },
);
journalEmbeddingSchema.index({ userId: 1, sourceType: 1, sourceId: 1 }, { unique: true });

export const JournalEmbedding =
  mongoose.models.JournalEmbedding || mongoose.model('JournalEmbedding', journalEmbeddingSchema);
