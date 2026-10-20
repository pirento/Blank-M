/**
 * POST /api/ai/picks: stock ideas from the verified NIFTY 500 universe. Each
 * request ID runs at most once; retries read the saved research run.
 */
import {
  loadResearchUniverse,
  ResearchUniverseError,
} from '../../services/ai/research-universe.js';
import {
  beginResearchRun,
  getResearchRun,
  finishResearchRun,
  failResearchRun,
} from '../../services/ai/research-archive.js';
import { z } from 'zod';
import { readJsonBody, requireMethod } from '../../services/http.js';
import { authenticateRequest } from '../../services/auth/request-auth.js';
import { enforceAiRateLimit } from '../../services/ai/usage-limits.js';
import { resolveAiConfig } from '../../services/ai/config.js';
import { pickedStockSchema, picksRequestSchema } from '../../shared/ai-schemas.js';
import { handleFailure } from './shared.js';
import { structured } from '../../services/ai/openai.js';

function researchResult(run) {
  if (run.outcome !== 'completed' || !run.finishedAt) {
    throw Object.assign(
      new Error(
        run.outcome === 'failed'
          ? 'This saved analysis failed. Run a new analysis to make another attempt.'
          : 'This analysis is already in progress or its outcome is uncertain. Refresh saved research; the same request will not start another model call.',
      ),
      { status: 409 },
    );
  }
  return {
    picks: run.picks,
    sources: run.sources,
    universe: run.universe.metadata,
    analysis: {
      id: run.id,
      requestId: run.requestId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
  };
}

/**
 * POST /api/ai/picks: returns the saved run for a repeated requestId instead of calling the
 * model again. Picks are limited to EQ-series symbols; a run that fails is marked failed.
 */
export async function handlePicks(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  let pending = null;
  try {
    const { user } = await authenticateRequest(req);
    const body = picksRequestSchema.parse(readJsonBody(req));
    const inputs = { strategies: body.strategies, rules: body.rules, count: body.count };
    const existing = await getResearchRun(user.id, body.requestId, inputs);
    if (existing) {
      res.status(200).json(researchResult(existing));
      return;
    }
    // Before anything is stored: a member over the limit must not fill the database with runs.
    await enforceAiRateLimit(user.id);
    const universe = await loadResearchUniverse();
    const { analysisModel } = await resolveAiConfig();
    const allowedSymbols = new Set(
      universe.constituents.filter((item) => item.series === 'EQ').map((item) => item.symbol),
    );
    if (!allowedSymbols.size)
      throw new ResearchUniverseError(
        'The verified index contains no supported EQ research candidates. Analysis has not started.',
      );
    const prompt = {
      model: analysisModel,
      system:
        'You research the Indian market for a trading journal. Use current, verifiable sources. Do not recommend trades or invent headlines; present candidates for independent review. Select only the supplied EQ-series symbols from the verified NIFTY 500 index snapshot. Other series are retained as index constituents but are ineligible for this research workflow. Index membership does not establish trading permission. Return fewer or zero candidates when evidence is insufficient.',
      input: `Find up to ${body.count} current NIFTY 500 volatility candidates for today.
Verified constituent source: ${universe.metadata.sourceUrl}
Snapshot fetched: ${universe.metadata.fetchedAt}
Constituent version: ${universe.metadata.version}
Published index constituents: ${universe.constituents.length}; EQ research eligible: ${allowedSymbols.size}; other-series excluded: ${universe.constituents.length - allowedSymbols.size}.
Allowed NSE symbols: ${[...allowedSymbols].join(', ')}
Strategies:
${body.strategies || '(none)'}
Constitution:
${body.rules || '(none)'}
For each, return an allowed NSE symbol, a concise reason, a detailed news explanation, and source citations.`,
    };
    const started = await beginResearchRun(
      user.id,
      body.requestId,
      { ...inputs, prompt },
      { metadata: universe.metadata, constituents: universe.constituents },
    );
    if (started.kind !== 'started') {
      res.status(200).json(researchResult(started.run));
      return;
    }
    pending = { userId: user.id, requestId: body.requestId };
    if (Date.now() >= Date.parse(universe.metadata.expiresAt))
      throw new ResearchUniverseError(
        'The verified constituent snapshot expired before the model request could start. Run a new analysis to refresh it.',
      );
    const parser = z
      .object({ picks: z.array(pickedStockSchema).max(body.count) })
      .superRefine((value, context) => {
        const selected = new Set();
        for (const pick of value.picks) {
          if (!allowedSymbols.has(pick.symbol) || selected.has(pick.symbol))
            context.addIssue({
              code: 'custom',
              message: 'Candidate is outside the verified universe or duplicated.',
            });
          selected.add(pick.symbol);
        }
      });
    const result = await structured({
      feature: 'picks',
      userId: user.id,
      model: analysisModel,
      webSearch: true,
      schemaName: 'blank_market_picks',
      system: prompt.system,
      input: prompt.input,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['picks'],
        properties: {
          picks: {
            type: 'array',
            maxItems: body.count,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['symbol', 'reason', 'detailedNews', 'citations'],
              properties: {
                symbol: { type: 'string', enum: [...allowedSymbols] },
                reason: { type: 'string' },
                detailedNews: { type: 'string' },
                citations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['title', 'url'],
                    properties: { title: { type: 'string' }, url: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      parser,
    });
    const saved = await finishResearchRun(user.id, body.requestId, {
      picks: result.data.picks,
      sources: result.sources,
    });
    pending = null;
    res.status(200).json(researchResult(saved));
  } catch (error) {
    if (pending) await failResearchRun(pending.userId, pending.requestId).catch(() => undefined);
    handleFailure(res, error);
  }
}
