/**
 * Coaching endpoints: the daily market briefing, trade review, chart/
 * screenshot analysis and the saved AI coach reviews of a day or week.
 */
import { readJsonBody, requireMethod } from '../../services/http.js';
import { authenticateRequest } from '../../services/auth/request-auth.js';
import { enforceAiRateLimit } from '../../services/ai/usage-limits.js';
import { resolveAiConfig } from '../../services/ai/config.js';
import {
  analyzeRequestSchema,
  analyzeResponseSchema,
  briefingRequestSchema,
  briefingResponseSchema,
  coachRequestSchema,
  reviewRequestSchema,
  reviewResponseSchema,
} from '../../shared/ai-schemas.js';
import { attachmentInput, handleFailure } from './shared.js';
import { structured } from '../../services/ai/openai.js';
import { listCoachReviews, runCoachReview } from '../../services/ai/coach-review.js';

/** POST /api/ai/briefing: a pre-market briefing from web search, with de-duplicated citations. */
export async function handleBriefing(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const { user } = await authenticateRequest(req);
    await enforceAiRateLimit(user.id);
    const body = briefingRequestSchema.parse(readJsonBody(req));
    const { analysisModel } = await resolveAiConfig();
    const result = await structured({
      feature: 'briefing',
      userId: user.id,
      model: analysisModel,
      webSearch: true,
      system:
        'Prepare a neutral pre-market briefing for an Indian-market trading journal. Use current, ' +
        'verifiable sources, separate facts from uncertainty, and never tell the user to buy or sell.',
      input:
        `Session date: ${body.date || new Date().toISOString().slice(0, 10)}\n\n` +
        `Strategies:\n${body.strategies || '(none)'}\n\n` +
        `Trading constitution:\n${body.rules || '(none)'}`,
      schemaName: 'blank_market_briefing',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['overview', 'marketDrivers', 'riskEvents', 'preparation', 'citations'],
        properties: {
          overview: { type: 'string' },
          marketDrivers: { type: 'array', maxItems: 8, items: { type: 'string' } },
          riskEvents: { type: 'array', maxItems: 8, items: { type: 'string' } },
          preparation: { type: 'array', maxItems: 8, items: { type: 'string' } },
          citations: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'url'],
              properties: { title: { type: 'string' }, url: { type: 'string' } },
            },
          },
        },
      },
      parser: briefingResponseSchema,
    });
    const citations = [...(result.data.citations ?? []), ...result.sources].filter(
      (item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index,
    );
    res.status(200).json({ ...result.data, citations });
  } catch (error) {
    handleFailure(res, error);
  }
}

/** POST /api/ai/review: a structured coach review of the supplied completed trades and rules. */
export async function handleReview(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const { user } = await authenticateRequest(req);
    await enforceAiRateLimit(user.id);
    const body = reviewRequestSchema.parse(readJsonBody(req));
    const { analysisModel } = await resolveAiConfig();
    const result = await structured({
      feature: 'review',
      userId: user.id,
      model: analysisModel,
      system:
        'Review completed trades as a quantitative trading coach. Judge process separately from ' +
        'outcome, cite only the supplied evidence, state uncertainty, and do not give investment advice.',
      input: `Completed trades:\n${body.trades}\n\nTrading rules:\n${body.rules || '(none)'}\n\nContext:\n${body.context || '(none)'}`,
      schemaName: 'blank_trade_review',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'strengths', 'risks', 'ruleAdherence', 'nextActions'],
        properties: {
          summary: { type: 'string' },
          strengths: { type: 'array', maxItems: 10, items: { type: 'string' } },
          risks: { type: 'array', maxItems: 10, items: { type: 'string' } },
          ruleAdherence: { type: 'array', maxItems: 10, items: { type: 'string' } },
          nextActions: { type: 'array', maxItems: 10, items: { type: 'string' } },
        },
      },
      parser: reviewResponseSchema,
    });
    res.status(200).json(result.data);
  } catch (error) {
    handleFailure(res, error);
  }
}

/**
 * POST /api/ai/analyze: structured analysis of an uploaded statement, chart or screenshot the
 * member owns.
 */
export async function handleAnalyze(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const { user } = await authenticateRequest(req);
    await enforceAiRateLimit(user.id);
    const body = analyzeRequestSchema.parse(readJsonBody(req));
    const { analysisModel } = await resolveAiConfig();
    const attachment = await attachmentInput(body.attachmentPath, user.id);
    const result = await structured({
      feature: `analyze_${body.kind}`,
      userId: user.id,
      model: analysisModel,
      system:
        'Analyze user-owned trading material. Extract only visible evidence, identify uncertainty, ' +
        'focus on process and risk, and never present output as investment advice.',
      input: [
        {
          role: 'user',
          content: [
            attachment,
            {
              type: 'input_text',
              text: `Material type: ${body.kind}. Context: ${body.context || '(none)'}`,
            },
          ],
        },
      ],
      schemaName: 'blank_material_analysis',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'observations', 'risks', 'actions'],
        properties: {
          summary: { type: 'string' },
          observations: { type: 'array', maxItems: 15, items: { type: 'string' } },
          risks: { type: 'array', maxItems: 10, items: { type: 'string' } },
          actions: { type: 'array', maxItems: 10, items: { type: 'string' } },
        },
      },
      parser: analyzeResponseSchema,
    });
    res.status(200).json(result.data);
  } catch (error) {
    handleFailure(res, error);
  }
}

/** POST /api/ai/coach-review { period, date? }: review a day or the last 7 days and save it. */
export async function handleCoachReview(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    const { user } = await authenticateRequest(req);
    const body = coachRequestSchema.parse(readJsonBody(req));
    await enforceAiRateLimit(user.id);
    res.status(201).json({ review: await runCoachReview(user.id, body) });
  } catch (error) {
    handleFailure(res, error);
  }
}

/** GET /api/ai/coach-reviews: the member's recent saved reviews, newest first. */
export async function handleCoachReviews(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  try {
    const { user } = await authenticateRequest(req);
    res.status(200).json({ reviews: await listCoachReviews(user.id) });
  } catch (error) {
    handleFailure(res, error);
  }
}
