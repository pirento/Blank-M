/**
 * Prints a one-time code an administrator needs to add their first authenticator
 * (Settings → Authenticator) when email is not set up. Valid 15 minutes.
 * Usage: node scripts/admin-setup-code.js admin@example.com
 */
import '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { User } from '../models/index.js';
import { issueAdminSetupCode } from '../services/auth/accounts.js';

const email = String(process.argv[2] || '')
  .trim()
  .toLowerCase();
if (!email) {
  console.error('Usage: node scripts/admin-setup-code.js admin@example.com');
  process.exit(1);
}

await connectDatabase();
try {
  const user = await User.findOne({ email });
  if (!user || user.role !== 'admin') {
    console.error('No administrator has this email.');
    process.exitCode = 1;
  } else if (user.hasVerifiedFactor()) {
    console.error('This administrator already has an authenticator; no code is needed.');
    process.exitCode = 1;
  } else {
    console.log(`Setup code for ${email} (valid 15 minutes): ${await issueAdminSetupCode(user)}`);
  }
} finally {
  await disconnectDatabase();
}
