/**
 * Small structured AI helpers: resolve a company name to an NSE symbol, draft a
 * trading rule, and write insights for a report.
 */
import { z } from 'zod';
import { readJsonBody, requireMethod } from '../../services/http.js';
import { authenticateRequest } from '../../services/auth/request-auth.js';
import { enforceAiRateLimit, recordAiUsage } from '../../services/ai/usage-limits.js';
import { resolveAiConfig } from '../../services/ai/config.js';
import {
  NSE_SYMBOL_RE,
  draftedRuleSchema,
  insightsRequestSchema,
  ruleRequestSchema,
  symbolRequestSchema,
} from '../../shared/ai-schemas.js';
import { handleFailure } from './shared.js';
import {
  ANALYSIS_MODEL,
  completedResponseText,
  createResponse,
  structured,
} from '../../services/ai/openai.js';

/**
 * POST /api/ai/symbol { query }: the NSE symbol for a company name, or null when unsure or
 * malformed.
 */
export async function handleSymbol(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const { user } = await authenticateRequest(req);
    await enforceAiRateLimit(user.id);
    const body = symbolRequestSchema.parse(readJsonBody(req));
    const { fastModel } = await resolveAiConfig();
    const parser = z.object({ symbol: z.string().nullable() });
    const result = await structured({
      feature: 'symbol',
      userId: user.id,
      model: fastModel,
      system: 'Resolve company names to current NSE symbols. Return null when uncertain.',
      input: `Return the NIFTY 500 NSE symbol for: "${body.query}".`,
      schemaName: 'nse_symbol',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['symbol'],
        properties: { symbol: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      },
      parser,
    });
    const symbol = result.data.symbol?.trim().toUpperCase() ?? null;
    res.status(200).json({ symbol: symbol && NSE_SYMBOL_RE.test(symbol) ? symbol : null });
  } catch (error) {
    handleFailure(res, error);
  }
}

/** POST /api/ai/rule: rewrites a draft trading rule to be concise and measurable. */
export async function handleRule(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const { user } = await authenticateRequest(req);
    await enforceAiRateLimit(user.id);
    const body = ruleRequestSchema.parse(readJsonBody(req));
    const { fastModel } = await resolveAiConfig();
    const result = await structured({
      feature: 'rule',
      userId: user.id,
      model: fastModel,
      system: 'Rewrite trading rules so they are concise, objective, measurable, and testable.',
      input: `Section: ${body.section}\nDefinition: ${body.definition}\nDraft rule: ${body.rule}`,
      schemaName: 'trading_rule',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'definition', 'rule'],
        properties: {
          section: { type: 'string' },
          definition: { type: 'string' },
          rule: { type: 'string' },
        },
      },
      parser: draftedRuleSchema,
    });
    res.status(200).json(result.data);
  } catch (error) {
    handleFailure(res, error);
  }
}

/** POST /api/ai/insights { report }: markdown insights on a trading report; records AI usage. */
export async function handleInsights(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  let userId = '';
  let model = ANALYSIS_MODEL;
  let response;
  try {
    const { user } = await authenticateRequest(req);
    await enforceAiRateLimit(user.id);
    const body = insightsRequestSchema.parse(readJsonBody(req));
    const { analysisModel } = await resolveAiConfig();
    userId = user.id;
    model = analysisModel;
    response = await createResponse({
      model: analysisModel,
      store: false,
      instructions:
        'Review a completed trading report as a quantitative analyst and trading psychologist. ' +
        'Use markdown headings, concrete metrics, rule adherence, uncertainty, and actionable process improvements.',
      input: body.report,
    });
    const text = completedResponseText(response);
    await recordAiUsage({
      userId: user.id,
      feature: 'insights',
      model: analysisModel,
      status: 'completed',
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      requestId: response.id,
    }).catch(() => undefined);
    res.status(200).json({ text });
  } catch (error) {
    if (userId) {
      await recordAiUsage({
        userId,
        feature: 'insights',
        model,
        status: 'failed',
        inputTokens: response?.usage?.input_tokens,
        outputTokens: response?.usage?.output_tokens,
        requestId: response?.id,
      }).catch(() => undefined);
    }
    handleFailure(res, error);
  }
}
