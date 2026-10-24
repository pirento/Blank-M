/**
 * Daily automatic journal (after the close): adds today's broker fills for
 * members who opted in and sends them the day's summary on Telegram. Run once
 * per trading day, after 15:30 IST.
 *
 * Usage:
 *   APP_URL=https://blank.example.com CRON_SECRET=... node scripts/daily-import.js
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

// 25 members a call (fewer when brokers are slow): room for well over 10,000 members.
const MAX_BATCHES = 2000;
// Each call handles one batch of members (each claimed for the day); repeat until none remain.
for (let batch = 1; batch <= MAX_BATCHES; batch += 1) {
  const response = await fetch(`${base}/api/maintenance/daily-import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    console.error(
      `Daily import failed (${response.status}): ${payload?.error ?? 'unexpected response'}`,
    );
    process.exit(1);
  }
  console.log(`Daily import: ${JSON.stringify(payload)}`);
  if (!payload.moreMayRemain) break;
}
