/**
 * Trade review fields shared by the server and browser: setup tags, mistake
 * tags, the emotion felt during the trade and the rupees planned at risk.
 * Tags are free text; the suggestions below are only offered in the form.
 */
import { riskFromStop } from './trade-execution.js';

export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 40;

/** Mistakes offered as one-tap chips (members can add their own). */
export const MISTAKE_SUGGESTIONS = [
  'No plan',
  'Chased entry',
  'Oversized',
  'Moved stop',
  'No stop',
  'Early exit',
  'Late exit',
  'Revenge trade',
  'Overtrading',
  'Ignored rule',
];

/** Setups offered as suggestions in the setup field. */
export const SETUP_SUGGESTIONS = [
  'Breakout',
  'Pullback',
  'Reversal',
  'Gap fill',
  'Opening range',
  'Trend follow',
  'Range',
  'News',
];

/** How the trade felt; '' means not recorded. */
export const EMOTIONS = [
  { value: '', label: 'Not recorded' },
  { value: 'calm', label: 'Calm' },
  { value: 'confident', label: 'Confident' },
  { value: 'anxious', label: 'Anxious' },
  { value: 'fearful', label: 'Fearful' },
  { value: 'greedy', label: 'Greedy' },
  { value: 'fomo', label: 'FOMO' },
  { value: 'frustrated', label: 'Frustrated' },
  { value: 'bored', label: 'Bored' },
];
export const EMOTION_VALUES = EMOTIONS.map((emotion) => emotion.value);

/**
 * Clean a tag list: accepts an array or a comma-separated string, trims and
 * collapses spaces, drops empties, keeps the first spelling of duplicates
 * (case-insensitive) and limits count and length.
 */
export function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    const tag = String(item ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

/**
 * Planned risk in rupees (what the trade would lose at its stop), or null when
 * not given. Returns undefined for an invalid value so callers can reject it.
 */
export function parsePlannedRisk(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || number <= 0 || number > 1e10) return undefined;
  return Math.round(number * 100) / 100;
}

/**
 * R-multiple of a trade: net P&L divided by planned risk, or null without risk.
 * Without an entered risk, the stop-loss distance is used (worked out now, so
 * it follows later edits to the stop or quantity).
 */
export function rMultiple(trade) {
  const risk =
    trade?.plannedRisk > 0
      ? trade.plannedRisk
      : riskFromStop(trade?.entryPrice, trade?.stopLoss, trade?.quantity);
  if (!risk) return null;
  return Math.round((trade.pnl / risk) * 100) / 100;
}
