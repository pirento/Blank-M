/**
 * Prints fresh random values for the secrets in .env, ready to paste.
 * Usage: node scripts/generate-secrets.js
 * Run it once per server. Never reuse these values elsewhere or commit them.
 */
import { randomBytes } from 'node:crypto';

const secret = (bytes) => randomBytes(bytes).toString('base64url');

console.log(
  [
    `SESSION_SECRET="${secret(48)}"`,
    // Separate from SESSION_SECRET, so rotating that one keeps authenticators working.
    `MFA_ENCRYPTION_KEY="${secret(48)}"`,
    `CRON_SECRET="${secret(48)}"`,
    // Exactly 32 bytes, hex: encrypts Zerodha and Dhan access tokens.
    `BROKER_TOKEN_ENCRYPTION_KEY="${randomBytes(32).toString('hex')}"`,
    `TELEGRAM_WEBHOOK_SECRET="${randomBytes(32).toString('hex')}"`,
  ].join('\n'),
);
