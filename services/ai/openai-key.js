/**
 * Reads the OpenAI API key from the server environment.
 */
import '../../config/env.js';

/** Resolve only server bindings; whitespace-only values are not configured credentials. */
export function openAiApiKey() {
  return (
    process.env.OPENAI_API_KEY?.trim() || process.env.BLANK_OPENAI_API_KEY?.trim() || undefined
  );
}

/** Whether an OpenAI API key is configured on this server. */
export function hasOpenAiKey() {
  return Boolean(openAiApiKey());
}
