/**
 * Bootstrap the first administrator.
 * Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='long secret' node scripts/create-admin.js
 */
import '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { AllowedUser, User } from '../models/index.js';
import { hashPassword } from '../services/auth/accounts.js';

const email = String(process.env.ADMIN_EMAIL || '')
  .trim()
  .toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || '');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) {
  console.error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.');
  process.exit(1);
}

await connectDatabase();
try {
  let user = await User.findOne({ email });
  if (user && user.role !== 'admin') {
    console.error(
      'This email already belongs to a member. Promote it through a reviewed operation instead.',
    );
    process.exitCode = 1;
  } else {
    user ??= await User.create({ email, role: 'admin', status: 'active' });
    user.passwordHash = await hashPassword(password);
    user.emailConfirmedAt ??= new Date();
    user.status = 'active';
    await user.save();
    await AllowedUser.updateOne(
      { _id: email },
      {
        $set: { role: 'admin', authUserId: user._id, revokedAt: null },
        $setOnInsert: { invitedAt: new Date(), acceptedAt: new Date() },
      },
      { upsert: true },
    );
    console.log(`Administrator ready: ${email}`);
  }
} finally {
  await disconnectDatabase();
}
