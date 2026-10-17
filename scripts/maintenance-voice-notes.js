/**
 * Scheduled voice-note cleanup (run daily from cron).
 * Calls the running server's maintenance endpoint with CRON_SECRET and repeats
 * while the server reports that more expired objects may remain.
 *
 * Usage (e.g. from a daily cron entry):
 *   APP_URL=https://blank.example.com CRON_SECRET=... node scripts/maintenance-voice-notes.js
 */
import '../config/env.js';

const MAX_BATCHES = 20;
const base = String(process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(
  /\/$/,
  '',
);
const secret = process.env.CRON_SECRET || '';
if (secret.length < 32) {
  console.error('Set CRON_SECRET (at least 32 characters) to the value configured on the server.');
  process.exit(1);
}

let total = 0;
for (let batch = 1; batch <= MAX_BATCHES; batch += 1) {
  const response = await fetch(`${base}/api/maintenance/voice-notes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.deleted !== 'number') {
    console.error(
      `Cleanup failed (${response.status}): ${payload?.error ?? 'unexpected response'}`,
    );
    process.exit(1);
  }
  total += payload.deleted;
  if (!payload.moreMayRemain) break;
}
console.log(`Voice-note cleanup complete: ${total} expired object(s) removed.`);
