/**
 * Scheduled weekly report emails. Run once a week (e.g. Monday 08:00 IST) after
 * the server is configured with SMTP and CRON_SECRET. Each member receives last
 * week's report at most once, so re-running the job is safe.
 *
 * Usage:
 *   APP_URL=https://blank.example.com CRON_SECRET=... node scripts/send-weekly-reports.js
 */
import '../config/env.js';

const MAX_BATCHES = 50;
const base = String(process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(
  /\/$/,
  '',
);
const secret = process.env.CRON_SECRET || '';
if (secret.length < 32) {
  console.error('Set CRON_SECRET (at least 32 characters) to the value configured on the server.');
  process.exit(1);
}

const totals = { sent: 0, skipped: 0, failed: 0 };
for (let batch = 1; batch <= MAX_BATCHES; batch += 1) {
  const response = await fetch(`${base}/api/maintenance/weekly-reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.sent !== 'number') {
    console.error(
      `Weekly reports failed (${response.status}): ${payload?.error ?? 'unexpected response'}`,
    );
    process.exit(1);
  }
  if (!payload.configured) {
    console.error('Email delivery is not configured on the server (SMTP_HOST and SMTP_FROM).');
    process.exit(1);
  }
  totals.sent += payload.sent;
  totals.skipped += payload.skipped;
  totals.failed += payload.failed;
  if (!payload.moreMayRemain || payload.sent === 0) break;
}
console.log(
  `Weekly reports: ${totals.sent} sent, ${totals.skipped} skipped, ${totals.failed} failed.`,
);
if (totals.failed) process.exitCode = 1;
