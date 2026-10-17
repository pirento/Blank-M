/**
 * Telegram endpoints: the bot webhook (authenticated by Telegram's secret
 * token header) and the member's link status, link code and unlink.
 */
import { timingSafeEqual } from 'node:crypto';
import { isTelegramConfigured } from '../services/telegram/api.js';
import {
  createLinkCode,
  handleUpdate,
  telegramStatus,
  unlinkTelegram,
} from '../services/telegram/bot.js';
import { createLogger } from '../services/logger.js';

const log = createLogger('telegram');

function secretMatches(header) {
  const expected = Buffer.from(process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '');
  const actual = Buffer.from(String(header ?? ''));
  return (
    expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual)
  );
}

/**
 * POST /api/telegram/webhook: handles the update, then always answers 200 so
 * Telegram never retries (a failed update is logged, not redelivered).
 */
export async function webhook(req, res) {
  if (!isTelegramConfigured() || !secretMatches(req.get('x-telegram-bot-api-secret-token'))) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }
  try {
    await handleUpdate(req.body);
  } catch {
    log.warn('telegram update failed');
  }
  res.status(200).json({ ok: true });
}

/** GET /api/telegram: whether the member has linked a Telegram chat, and its username. */
export async function status(req, res) {
  res.json(await telegramStatus(req.member.userId));
}

/** POST /api/telegram/link: a one-time t.me link that connects a chat, valid for 10 minutes (201). */
export async function link(req, res) {
  res.status(201).json(await createLinkCode(req.member.userId));
}

/** POST /api/telegram/unlink: disconnects the member's Telegram chat and returns the new status. */
export async function unlink(req, res) {
  await unlinkTelegram(req.member.userId);
  res.json(await telegramStatus(req.member.userId));
}
