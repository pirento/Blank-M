/**
 * Analytics page data and state, the in-flight request trackers and helpers
 * that keep conversation actions from overlapping.
 */
import { $, pageData } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { paint, paintMessages } from './render.js';

export const TRADING_TERMS = [
  'RSI',
  'MACD',
  'EMA',
  'SMA',
  'VWAP',
  'Bollinger Bands',
  'Fibonacci',
  'Pivot Points',
  'Support',
  'Resistance',
  'Breakout',
  'Pullback',
  'Stop Loss',
  'Take Profit',
  'Trailing Stop',
  'Order Block',
  'Liquidity',
  'Wyckoff',
  'Elliott Wave',
  'Volume Profile',
  'Moving Average',
];

export const data = pageData();
export const workspace = data.workspace ?? { trades: [], rules: [], chatMessages: [] };
export const aiReady = Boolean(data.health?.aiAvailable);
export const state = {
  messages: workspace.chatMessages ?? [],
  loading: false,
  streamText: '',
  savingReply: false,
  notice: null,
  pendingPreparation: null,
  selectedFile: null,
  suggestions: [],
  focusedSuggestion: 0,
  voiceLoading: false,
  materialLoading: false,
  reviewLoading: false,
  searchLoading: false,
  clearing: false,
};
// The streaming chat request and the preparation step before it (both abortable).
export const live = { chat: null, preparation: null };
const auxiliary = new Map();

export const question = $('[data-question]');
export const attachmentInput = $('[data-attachment]');
export const voiceInput = $('[data-voice]');

/** True while a structured analysis, trade review or clear is running. */
export const conversationBusy = () =>
  ['material', 'review', 'clear'].some((kind) => auxiliary.has(kind));
/**
 * Starts a side task (`material`, `review`, `clear`, …) and returns its AbortController,
 * or null when AI is not ready, the task is already running, or a chat is in flight.
 */
export function beginAuxiliary(kind) {
  if (kind !== 'clear' && !aiReady) return null;
  if (auxiliary.has(kind)) return null;
  if (
    ['material', 'review', 'clear'].includes(kind) &&
    (live.chat || live.preparation || conversationBusy())
  )
    return null;
  const controller = new AbortController();
  auxiliary.set(kind, controller);
  return controller;
}
/** True when `controller` is still the live, unaborted controller for that side task. */
export const currentAuxiliary = (kind, controller) =>
  auxiliary.get(kind) === controller && !controller.signal.aborted;
/** Finishes a side task: clears its entry, resets the `state[flag]` loading flag and repaints. */
export function endAuxiliary(kind, controller, flag) {
  if (currentAuxiliary(kind, controller)) {
    auxiliary.delete(kind);
    state[flag] = false;
    paint();
  }
}

/** Saves a chat message via POST /api/chat/messages, appends it to the list and repaints it. */
export async function addChatMessage(message) {
  const result = await api('/api/chat/messages', { method: 'POST', body: message });
  state.messages = [...state.messages, result.message];
  paintMessages();
  return result.message;
}
