/**
 * Daily: emails members whose free trial ends within 3 days (once per trial).
 * Usage: node scripts/billing-reminders.js
 */
import '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { applyPlatformSettings } from '../services/platform/settings.js';
import { sendTrialReminders } from '../services/notifications/emails.js';

await connectDatabase();
try {
  // Email (SMTP) may be set in the admin panel rather than .env.
  await applyPlatformSettings();
  console.log(`Trial reminders sent: ${await sendTrialReminders()}`);
} finally {
  await disconnectDatabase();
}
