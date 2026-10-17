/**
 * Zod schemas for AI requests and responses, shared by the server and browser.
 */
import { z } from 'zod';

export const NSE_SYMBOL_RE = /^[A-Z0-9][A-Z0-9&.-]{0,19}$/;

export const citationSchema = z.object({
  title: z.string().min(1).max(300),
  url: z.string().url(),
});

export const pickedStockSchema = z.object({
  symbol: z.string().regex(NSE_SYMBOL_RE, 'not a plausible NSE symbol'),
  reason: z.string().min(1).max(500),
  detailedNews: z.string().max(4000).default(''),
  citations: z.array(citationSchema).max(8).default([]),
});

export const researchUniverseMetadataSchema = z.object({
  name: z.literal('NIFTY 500'),
  sourceUrl: z.literal('https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv'),
  fetchedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  version: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  // A published index can temporarily contain additional securities. These
  // bounds detect gross anomalies; they do not establish index completeness.
  constituentCount: z.number().int().min(400).max(600),
  eligibleConstituentCount: z.number().int().min(1).max(600).optional(),
});

export const researchUniverseSnapshotSchema = z.object({
  metadata: researchUniverseMetadataSchema,
  constituents: z
    .array(
      z.object({
        name: z.string().min(1).max(300),
        industry: z.string().min(1).max(300),
        symbol: z.string().regex(NSE_SYMBOL_RE),
        series: z.string().regex(/^[A-Z]{1,4}$/),
        isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/),
      }),
    )
    .min(400)
    .max(600),
});
export const researchRunInputsSchema = z.object({
  prompt: z
    .object({
      system: z.string().max(4000),
      input: z.string().max(60000),
      model: z.string().max(200),
    })
    .optional(),
  strategies: z.string().max(20000),
  rules: z.string().max(20000),
  count: z.number().int().min(1).max(10),
});
export const durableResearchRunSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  ownerId: z.string().min(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  outcome: z.enum(['pending', 'completed', 'failed']),
  inputs: researchRunInputsSchema,
  universe: researchUniverseSnapshotSchema,
  picks: z.array(pickedStockSchema).max(10),
  sources: z.array(citationSchema),
});

export const researchAnalysisReceiptSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});
export const researchHistoryCursorSchema = z.string().uuid();
export const researchHistoryResponseSchema = z.object({
  runs: z.array(durableResearchRunSchema).max(50),
  maxRuns: z.literal(50),
  nextCursor: researchHistoryCursorSchema.nullable().default(null),
});

export const picksResponseSchema = z.object({
  picks: z.array(pickedStockSchema),
  sources: z.array(citationSchema).default([]),
  universe: researchUniverseMetadataSchema,
  analysis: researchAnalysisReceiptSchema,
});

export const draftedRuleSchema = z.object({
  section: z.string().min(1).max(200),
  definition: z.string().min(1).max(2000),
  rule: z.string().min(1).max(4000),
});

export const symbolResponseSchema = z.object({ symbol: z.string().nullable() });
export const chatRoleSchema = z.enum(['user', 'assistant']);
export const chatTurnSchema = z.object({ role: chatRoleSchema, text: z.string().max(20000) });

export const MAX_CHAT_HISTORY_MESSAGES = 100;

export const chatRequestSchema = z.object({
  history: z.array(chatTurnSchema).max(MAX_CHAT_HISTORY_MESSAGES).default([]),
  message: z.string().max(20000).default(''),
  rules: z.string().max(20000).optional(),
  attachmentPath: z.string().max(500).optional(),
});

export const picksRequestSchema = z.object({
  requestId: z.string().uuid(),
  strategies: z.string().max(20000).default(''),
  rules: z.string().max(20000).default(''),
  count: z.number().int().min(1).max(10).default(10),
});
export const symbolRequestSchema = z.object({ query: z.string().min(1).max(200) });
export const ruleRequestSchema = z.object({
  section: z.string().max(500).default(''),
  definition: z.string().max(2000).default(''),
  rule: z.string().max(4000).default(''),
});
export const insightsRequestSchema = z.object({ report: z.string().min(1).max(200000) });
export const textResponseSchema = z.object({ text: z.string() });

export const briefingRequestSchema = z.object({
  date: z.string().max(40).optional(),
  strategies: z.string().max(20000).default(''),
  rules: z.string().max(20000).default(''),
});
export const briefingResponseSchema = z.object({
  overview: z.string().min(1).max(4000),
  marketDrivers: z.array(z.string().min(1).max(1000)).max(8),
  riskEvents: z.array(z.string().min(1).max(1000)).max(8),
  preparation: z.array(z.string().min(1).max(1000)).max(8),
  citations: z.array(citationSchema).max(20).default([]),
});

export const reviewRequestSchema = z.object({
  trades: z.string().min(1).max(150000),
  rules: z.string().max(20000).default(''),
  context: z.string().max(10000).default(''),
});
export const reviewResponseSchema = z.object({
  summary: z.string().min(1).max(4000),
  strengths: z.array(z.string().min(1).max(1000)).max(10),
  risks: z.array(z.string().min(1).max(1000)).max(10),
  ruleAdherence: z.array(z.string().min(1).max(1000)).max(10),
  nextActions: z.array(z.string().min(1).max(1000)).max(10),
});

export const analyzeRequestSchema = z.object({
  attachmentPath: z.string().min(1).max(500),
  kind: z.enum(['statement', 'chart']).default('statement'),
  context: z.string().max(10000).default(''),
});
export const analyzeResponseSchema = z.object({
  summary: z.string().min(1).max(4000),
  observations: z.array(z.string().min(1).max(1200)).max(15),
  risks: z.array(z.string().min(1).max(1200)).max(10),
  actions: z.array(z.string().min(1).max(1200)).max(10),
});

export const transcribeRequestSchema = z.object({
  audioPath: z.string().min(1).max(500),
  filename: z.string().min(1).max(180),
  mime: z.enum(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/x-m4a']),
});
export const transcriptionResponseSchema = z.object({ transcript: z.string().max(100000) });

export const journalSourceSchema = z.object({
  sourceType: z.enum(['trade', 'strategy', 'rule', 'chat']),
  sourceId: z.string().uuid(),
  title: z.string().min(1).max(300),
  snippet: z.string().max(1600),
});
export const journalSearchRequestSchema = z.object({ query: z.string().min(2).max(1000) });
export const journalSearchResponseSchema = z.object({
  answer: z.string().max(12000),
  sources: z.array(journalSourceSchema).max(12),
});

export const ANALYSIS_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
export const FAST_MODELS = ['gpt-5.6-terra', 'gpt-5.6-luna'];
export const aiModelConfigSchema = z.object({
  analysisModel: z.enum(ANALYSIS_MODELS),
  fastModel: z.enum(FAST_MODELS),
});

/* ------------------------------------ AI coach review ------------------------------------ */

export const coachRequestSchema = z
  .object({
    period: z.enum(['day', 'week']).default('week'),
    /** Last day of the period (IST, YYYY-MM-DD); today when omitted. */
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        // A real calendar day: 2026-13-45 or 2026-02-30 is rejected, not a 500.
        const parsed = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      }, 'Choose a valid date.')
      .optional(),
  })
  .strict();

export const coachResponseSchema = z.object({
  summary: z.string().min(1).max(3000),
  wentWell: z.array(z.string().min(1).max(600)).max(6),
  mistakes: z
    .array(
      z.object({
        pattern: z.string().min(1).max(400),
        evidence: z.string().min(1).max(600),
        fix: z.string().min(1).max(600),
      }),
    )
    .max(6),
  ruleAdherence: z
    .array(
      z.object({
        rule: z.string().min(1).max(400),
        status: z.enum(['followed', 'partly', 'broken', 'unclear']),
        note: z.string().max(600),
      }),
    )
    .max(10),
  disciplineScore: z.number().int().min(0).max(10),
  focus: z.array(z.string().min(1).max(300)).min(1).max(3),
});
