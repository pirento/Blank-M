/**
 * AI model configuration: environment defaults, the stored singleton that
 * administrators edit, and the allowed model lists.
 */
import { ANALYSIS_MODELS, FAST_MODELS, aiModelConfigSchema } from '../../shared/ai-schemas.js';
import { AiConfiguration } from '../../models/index.js';
import { isDatabaseConnected } from '../../config/database.js';
import { createLogger } from '../logger.js';

const log = createLogger('ai-config');

export const TRANSCRIPTION_MODEL = 'gpt-transcribe';
export const EMBEDDING_MODEL = 'text-embedding-3-small';

function allowed(value, values, fallback) {
  return values.includes(value) ? value : fallback;
}

export const ENV_AI_CONFIG = {
  analysisModel: allowed(process.env.OPENAI_ANALYSIS_MODEL, ANALYSIS_MODELS, 'gpt-5.6-terra'),
  fastModel: allowed(process.env.OPENAI_FAST_MODEL, FAST_MODELS, 'gpt-5.6-luna'),
};

let cached = null;

/** Seed the singleton row once, so administrators always edit an existing configuration. */
export async function ensureAiConfiguration() {
  await AiConfiguration.updateOne(
    { _id: 1 },
    {
      $setOnInsert: {
        analysisModel: ENV_AI_CONFIG.analysisModel,
        fastModel: ENV_AI_CONFIG.fastModel,
      },
    },
    { upsert: true },
  );
}

/**
 * The active analysis/fast model pair from the stored singleton, cached for 60 s. Falls back to the
 * environment defaults when the database is down or the row is missing or invalid.
 */
export async function resolveAiConfig() {
  if (cached && cached.expires > Date.now()) return cached.value;
  if (!isDatabaseConnected()) return ENV_AI_CONFIG;
  let row = null;
  try {
    row = await AiConfiguration.findById(1).lean();
  } catch {
    log.warn('using environment defaults; stored routing is unavailable');
  }
  const parsed = aiModelConfigSchema.safeParse(
    row ? { analysisModel: row.analysisModel, fastModel: row.fastModel } : ENV_AI_CONFIG,
  );
  const value = parsed.success ? parsed.data : ENV_AI_CONFIG;
  cached = { value, expires: Date.now() + 60_000 };
  return value;
}

/**
 * Validates and stores the administrator's model choice, then refreshes the in-process cache.
 * Throws a ZodError for models outside the allowed lists.
 */
export async function saveAiConfig(config, adminId) {
  const value = aiModelConfigSchema.parse(config);
  await AiConfiguration.updateOne(
    { _id: 1 },
    {
      $set: { analysisModel: value.analysisModel, fastModel: value.fastModel, updatedBy: adminId },
    },
    { upsert: true },
  );
  cached = { value, expires: Date.now() + 60_000 };
}

/**
 * The model configuration plus the fixed transcription/embedding models and the allowed model
 * lists, for the admin UI.
 */
export function publicAiConfig(value) {
  return {
    ...value,
    transcriptionModel: TRANSCRIPTION_MODEL,
    embeddingModel: EMBEDDING_MODEL,
    allowedAnalysisModels: [...ANALYSIS_MODELS],
    allowedFastModels: [...FAST_MODELS],
  };
}
