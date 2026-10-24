/**
 * Registers this server's Telegram webhook (run once after setting
 * TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET and an
 * HTTPS APP_URL). The admin panel → Integrations → Telegram bot → "Set webhook"
 * does the same.
 *
 * Usage:  node scripts/telegram-set-webhook.js
 */
import '../config/env.js';
import { registerTelegramWebhook } from '../services/telegram/api.js';

try {
  console.log(`Telegram webhook set to ${await registerTelegramWebhook()}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
