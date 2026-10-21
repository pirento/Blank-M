/**
 * OpenAI access for Blank AI: the configured models, the client, structured
 * (JSON-schema) responses, streaming, and extracting verified output text and
 * web sources from a Responses API result.
 */
import '../../config/env.js';
import OpenAI from 'openai';
import { openAiApiKey } from './openai-key.js';
import { z } from 'zod';
import { recordAiUsage } from './usage-limits.js';
import { ENV_AI_CONFIG } from './config.js';

export const ANALYSIS_MODEL = ENV_AI_CONFIG.analysisModel;
export const FAST_MODEL = ENV_AI_CONFIG.fastModel;

/**
 * A new OpenAI client with a 75 s timeout and one retry. Throws a 503 error when no API key is
 * configured.
 */
export function openAiClient() {
  const apiKey = openAiApiKey();
  if (!apiKey) {
    throw Object.assign(new Error('OpenAI is not configured on this deployment.'), { status: 503 });
  }
  // One retry within 2 × 75 s stays under the proxy's 180 s request limit.
  return new OpenAI({ apiKey, timeout: 75_000, maxRetries: 1 });
}

/**
 * HTTP status to report for an error: its own 4xx/5xx status, 400 for a ZodError, otherwise 502.
 */
export function statusOf(error) {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = Number(error.status);
    if (Number.isInteger(status) && status >= 400 && status < 600) return status;
  }
  if (error instanceof z.ZodError) return 400;
  return 502;
}

export class ChatStreamFailure extends Error {
  status = 502;

  constructor(code) {
    super(
      code === 'incomplete'
        ? 'The AI response ended before it was complete. Please try again.'
        : 'The AI request failed. Please try again.',
    );
    this.code = code;
    this.name = 'ChatStreamFailure';
  }
}

function jsonSchema(name, schema) {
  return { type: 'json_schema', name, strict: true, schema };
}

export class AiResponseFailure extends Error {
  status = 502;

  constructor() {
    super('The AI response was not a verified completed output.');
    this.name = 'AiResponseFailure';
  }
}

/**
 * Runs a provider call and replaces any failure with a generic AiResponseFailure, so provider error
 * details never leak.
 */
export async function providerRequest(request) {
  try {
    return await request();
  } catch {
    // Even provider 4xx errors can include credentials, account details or input.
    throw new AiResponseFailure();
  }
}

export async function* providerStream(stream) {
  try {
    yield* stream;
  } catch {
    throw new AiResponseFailure();
  }
}

/**
 * Creates a Responses API request, with provider errors masked as AiResponseFailure. Never
 * retried: a request that timed out on our side may already have been run (and billed).
 */
export async function createResponse(params, options) {
  const client = openAiClient();
  return providerRequest(() => client.responses.create(params, { ...options, maxRetries: 0 }));
}

/**
 * The response's output text, only when the response and every message part completed as plain
 * output text. Throws AiResponseFailure for incomplete, errored, refused or inconsistent output.
 */
export function completedResponseText(response) {
  // Parseable text alone is not success: SDK output_text can also contain partial output.
  if (
    response.status !== 'completed' ||
    response.error ||
    response.incomplete_details ||
    !Array.isArray(response.output) ||
    typeof response.output_text !== 'string' ||
    !response.output_text.trim()
  ) {
    throw new AiResponseFailure();
  }
  const text = [];
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    if (item.status !== 'completed' || !Array.isArray(item.content)) {
      throw new AiResponseFailure();
    }
    for (const content of item.content) {
      // Refusals can coexist with text; never treat their text sibling as a successful answer.
      if (content.type !== 'output_text' || typeof content.text !== 'string') {
        throw new AiResponseFailure();
      }
      text.push(content.text);
    }
  }
  // Match the SDK's aggregation across messages, without assuming output[0] is a message.
  if (text.join('') !== response.output_text) throw new AiResponseFailure();
  return response.output_text;
}

function extractSources(value) {
  const found = new Map();
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node;
    if (typeof record.url === 'string' && /^https:\/\//i.test(record.url)) {
      const title =
        typeof record.title === 'string' && record.title.trim() ? record.title.trim() : record.url;
      found.set(record.url, { title: title.slice(0, 300), url: record.url });
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...found.values()].slice(0, 20);
}

/**
 * Requests a JSON-schema response (optionally with web search), parses it with `options.parser` and
 * records usage either way. Returns `{ data, sources }`; any provider or parse failure becomes
 * AiResponseFailure.
 */
export async function structured(options) {
  let response;
  try {
    response = await createResponse({
      model: options.model,
      store: false,
      instructions: options.system,
      input: options.input,
      ...(options.webSearch
        ? {
            tools: [{ type: 'web_search' }],
            include: ['web_search_call.action.sources'],
          }
        : {}),
      text: { format: jsonSchema(options.schemaName, options.schema) },
    });
    const text = completedResponseText(response);
    let data;
    try {
      data = options.parser.parse(JSON.parse(text));
    } catch {
      // Provider JSON/schema failures are upstream failures, not invalid user requests.
      throw new AiResponseFailure();
    }
    await recordAiUsage({
      userId: options.userId,
      feature: options.feature,
      model: options.model,
      status: 'completed',
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      requestId: response.id,
    }).catch(() => undefined);
    return { data, sources: extractSources(response.output) };
  } catch (error) {
    await recordAiUsage({
      userId: options.userId,
      feature: options.feature,
      model: options.model,
      status: 'failed',
      inputTokens: response?.usage?.input_tokens,
      outputTokens: response?.usage?.output_tokens,
      requestId: response?.id,
    }).catch(() => undefined);
    throw error;
  }
}
