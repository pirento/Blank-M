/**
 * Scheduled price checks: closes paper trades whose stop or target was crossed
 * (and, once configured, fires price alerts). Run every few minutes during
 * market hours.
 *
 * Usage:
 *   APP_URL=https://blank.example.com CRON_SECRET=... node scripts/price-checks.js
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

const response = await fetch(`${base}/api/maintenance/price-checks`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
});
const payload = await response.json().catch(() => null);
if (!response.ok || !payload) {
  console.error(
    `Price checks failed (${response.status}): ${payload?.error ?? 'unexpected response'}`,
  );
  process.exit(1);
}
console.log(`Price checks: ${JSON.stringify(payload)}`);
