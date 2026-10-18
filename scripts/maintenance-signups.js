/**
 * Deletes public sign-ups whose email was never confirmed within 7 days
 * (run daily from cron). Admin invitations are never touched.
 * Usage: node scripts/maintenance-signups.js
 */
import '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { deleteUnconfirmedSignups } from '../services/auth/accounts.js';

await connectDatabase();
try {
  console.log(`Unconfirmed sign-ups removed: ${await deleteUnconfirmedSignups()}`);
} finally {
  await disconnectDatabase();
}
