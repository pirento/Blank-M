/**
 * Copies trade screenshots from MongoDB GridFS to the S3 bucket set in the admin panel →
 * Integrations (or .env). Safe to stop and re-run: files already in S3 with the same size are
 * skipped. Run it again with --delete to remove each GridFS copy once its S3 copy is checked.
 * Usage: node scripts/migrate-screenshots-to-s3.js [--delete]
 */
import '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { applyPlatformSettings } from '../services/platform/settings.js';
import { migrateScreenshotsToS3 } from '../services/storage.js';

await connectDatabase();
// S3 keys saved in the admin panel live in the database.
await applyPlatformSettings();
try {
  const result = await migrateScreenshotsToS3({
    remove: process.argv.includes('--delete'),
    log: (line) => console.log(line),
  });
  console.log(
    `Done: ${result.copied} copied, ${result.present} already in S3, ${result.removed} GridFS copies deleted, ${result.failed} failed.`,
  );
  if (result.failed) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
