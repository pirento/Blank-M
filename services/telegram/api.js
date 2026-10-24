/**
 * Telegram Bot API client: configuration checks, sending messages and
 * registering the webhook. Needs TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and
 * TELEGRAM_WEBHOOK_SECRET.
 */
import { HttpError } from '../errors.js';

const API = 'https://api.telegram.org';

/** Whether the bot token and username are set and the webhook secret has at least 32 characters. */
export function isTelegramConfigured() {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN?.trim() &&
    process.env.TELEGRAM_BOT_USERNAME?.trim() &&
    (process.env.TELEGRAM_WEBHOOK_SECRET?.trim().length ?? 0) >= 32,
  );
}

/** The configured bot username without a leading @, or '' when unset. */
export const botUsername = () => process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') ?? '';

async function call(method, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN.trim()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!payload?.ok) throw new Error(`Telegram ${method} failed (${response.status})`);
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Sends a plain-text message (no Markdown, so journal text can never inject formatting). */
export function sendTelegramMessage(chatId, text) {
  return call('sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4000),
    disable_web_page_preview: true,
  });
}

/** Points the bot at this server's webhook with the shared secret header. */
export function setTelegramWebhook(url) {
  return call('setWebhook', {
    url,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET.trim(),
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
}

/** The bot behind TELEGRAM_BOT_TOKEN (`{ username, … }`); throws when Telegram refuses the token. */
export const telegramBot = () => call('getMe', {});

/**
 * Registers `APP_URL/api/telegram/webhook` (scripts/telegram-set-webhook.js and the admin panel's
 * "Set webhook" button). Returns the URL; throws HttpError 409 when the settings are not ready.
 */
export async function registerTelegramWebhook() {
  if (!isTelegramConfigured()) {
    throw new HttpError(
      'Set TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET (32+ characters).',
      409,
    );
  }
  const base = String(process.env.APP_URL || '').replace(/\/$/, '');
  if (!base.startsWith('https://')) {
    throw new HttpError(
      'APP_URL must be the public HTTPS address; Telegram only calls HTTPS webhooks.',
      409,
    );
  }
  await setTelegramWebhook(`${base}/api/telegram/webhook`);
  return `${base}/api/telegram/webhook`;
}
