/**
 * Scheduled pre-market plan (before the open): sends a short plan to the
 * linked Telegram chat of members who opted in. Run once per trading day at
 * about 08:45 IST; the server skips holidays and refuses after 09:15 IST.
 *
 * Usage:
 *   APP_URL=https://blank.example.com CRON_SECRET=... node scripts/premarket-plan.js
 */
import '../config/env.js';

const base = String(process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(
  /\/$/,
  '',
);
const secret = process.env.CRON_SECRET || '';
if (secret.length < 32) {
  console.error('Set CRON_SECRET (at least 32 characters) to the value configured on the server.');
  process.exit(1);
}

const response = await fetch(`${base}/api/maintenance/premarket-plan`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
});
const payload = await response.json().catch(() => null);
if (!response.ok || !payload) {
  console.error(
    `Pre-market plan failed (${response.status}): ${payload?.error ?? 'unexpected response'}`,
  );
  process.exit(1);
}
console.log(`Pre-market plan: ${JSON.stringify(payload)}`);
