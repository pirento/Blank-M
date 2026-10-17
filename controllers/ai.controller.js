/**
 * Blank AI HTTP handlers. Each feature lives in controllers/ai/:
 *
 * - chat.js            streaming coach chat with optional statement attachment
 * - research.js        stock picks from the NIFTY 500 universe (saved research runs)
 * - drafting.js        symbol lookup, rule drafting and report insights
 * - coach.js           daily briefing, trade review, chart analysis, coach reviews
 * - voice.js           voice-note transcription
 * - journal-search.js  private journal search (embeddings)
 *
 * OpenAI request helpers live in services/ai/openai.js and the journal
 * embedding index in services/ai/journal-index.js. This file keeps the original
 * import path for routes and other controllers.
 */
export {
  ANALYSIS_MODEL,
  FAST_MODEL,
  completedResponseText,
  createResponse,
  openAiClient,
} from '../services/ai/openai.js';
export {
  assertAttachmentFile,
  assertAttachmentOwnership,
  sseData,
  trimHistory,
} from './ai/shared.js';
export { assertAudioFile, handleTranscribe } from './ai/voice.js';
export { cosineSimilarity } from '../services/ai/journal-index.js';
export {
  handleAnalyze,
  handleBriefing,
  handleCoachReview,
  handleCoachReviews,
  handleReview,
} from './ai/coach.js';
export { handleChat } from './ai/chat.js';
export { handleInsights, handleRule, handleSymbol } from './ai/drafting.js';
export { handleJournalSearch } from './ai/journal-search.js';
export { handlePicks } from './ai/research.js';
