/**
 * Administrator AI settings: read and update the model configuration, and run a
 * small test request.
 */
import { z } from 'zod';
import { aiModelConfigSchema } from '../shared/ai-schemas.js';
import { publicAiConfig, resolveAiConfig, saveAiConfig } from '../services/ai/config.js';
import { completedResponseText, createResponse } from './ai.controller.js';
import { readJsonBody, requireMethod } from '../services/http.js';
import { enforceAiRateLimit, recordAiUsage } from '../services/ai/usage-limits.js';
import { requireAdmin } from '../services/auth/request-auth.js';
import { createLogger } from '../services/logger.js';

const log = createLogger('admin-ai');

function failure(res, error) {
  const status =
    error instanceof z.ZodError
      ? 400
      : typeof error === 'object' && error !== null && 'status' in error
        ? Number(error.status)
        : 502;
  if (status >= 500) log.error('request failed', { status });
  res.status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 502).json({
    error:
      status < 500 && error instanceof Error
        ? error.message
        : 'The OpenAI configuration request could not be completed.',
  });
}

/** GET /api/admin/ai/config: the current AI model configuration (administrators only). */
export async function handleGetAiConfig(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!requireMethod(req, res, 'GET')) return;
  try {
    await requireAdmin(req);
    res.status(200).json(publicAiConfig(await resolveAiConfig()));
  } catch (error) {
    failure(res, error);
  }
}

/** PUT /api/admin/ai/config: validates and saves the AI model configuration (administrators only). */
export async function handleUpdateAiConfig(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!requireMethod(req, res, 'PUT')) return;
  try {
    const admin = await requireAdmin(req);
    const config = aiModelConfigSchema.parse(readJsonBody(req));
    await saveAiConfig(config, admin.user.id);
    res.status(200).json(publicAiConfig(config));
  } catch (error) {
    failure(res, error);
  }
}

/**
 * POST /api/admin/ai/test: asks each configured model (or the models in the body) to reply
 * "operational" and reports which did. Rate-limited and recorded as AI usage.
 */
export async function handleTestAiConfig(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const admin = await requireAdmin(req);
    await enforceAiRateLimit(admin.user.id);
    const input = readJsonBody(req);
    const config = Object.keys(input).length
      ? aiModelConfigSchema.parse(input)
      : await resolveAiConfig();
    const models = [...new Set([config.analysisModel, config.fastModel])];
    const results = await Promise.all(
      models.map(async (model) => {
        try {
          const response = await createResponse({
            model,
            store: false,
            input: 'Reply with exactly: operational',
            max_output_tokens: 256,
          });
          const operational = completedResponseText(response).trim() === 'operational';
          await recordAiUsage({
            userId: admin.user.id,
            feature: 'admin_model_test',
            model,
            status: operational ? 'completed' : 'failed',
            inputTokens: response.usage?.input_tokens,
            outputTokens: response.usage?.output_tokens,
            requestId: response.id,
          }).catch(() => undefined);
          return { model, operational };
        } catch (error) {
          await recordAiUsage({
            userId: admin.user.id,
            feature: 'admin_model_test',
            model,
            status: 'failed',
          }).catch(() => undefined);
          throw error;
        }
      }),
    );
    res.status(200).json({ ok: results.every((result) => result.operational), results });
  } catch (error) {
    failure(res, error);
  }
}
