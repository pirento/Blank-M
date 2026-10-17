/**
 * Registers this server's Telegram webhook (run once after setting
 * TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET and an
 * HTTPS APP_URL).
 *
 * Usage:  node scripts/telegram-set-webhook.js
 */
import '../config/env.js';
import { isTelegramConfigured, setTelegramWebhook } from '../services/telegram/api.js';

if (!isTelegramConfigured()) {
  console.error(
    'Set TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET (32+ characters).',
  );
  process.exit(1);
}
const base = String(process.env.APP_URL || '').replace(/\/$/, '');
if (!base.startsWith('https://')) {
  console.error('APP_URL must be the public HTTPS address; Telegram only calls HTTPS webhooks.');
  process.exit(1);
}
await setTelegramWebhook(`${base}/api/telegram/webhook`);
console.log(`Telegram webhook set to ${base}/api/telegram/webhook`);
