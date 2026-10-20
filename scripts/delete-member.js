/**
 * Deletes a member and all their data for good (a deletion request under the
 * privacy policy). Payments and the audit log are kept. Cannot be undone, so it
 * asks you to type the email twice.
 * Usage: node scripts/delete-member.js member@example.com member@example.com
 */
import '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { deleteMember } from '../services/admin/delete-member.js';

const [email, confirm] = process.argv.slice(2);
if (!email || email !== confirm) {
  console.error('Usage: node scripts/delete-member.js <email> <same email again>');
  process.exit(1);
}

await connectDatabase();
try {
  const result = await deleteMember(email);
  console.log(`Deleted ${result.email}: ${result.rows} records, ${result.files} files.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
