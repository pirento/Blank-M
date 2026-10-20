/**
 * Bootstrap the first administrator. Administrators have no password: they sign in at
 * /admin/login with the Google account of this email, then add an authenticator app
 * (the code it asks for comes by email, or from scripts/admin-setup-code.js).
 * Usage: ADMIN_EMAIL=you@gmail.com node scripts/create-admin.js
 */
import '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { AllowedUser, User } from '../models/index.js';

const email = String(process.env.ADMIN_EMAIL || '')
  .trim()
  .toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Set ADMIN_EMAIL to the Google account the administrator will sign in with.');
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
    user.emailConfirmedAt ??= new Date();
    user.status = 'active';
    // A password is never used for administrators.
    user.passwordHash = null;
    await user.save();
    await AllowedUser.updateOne(
      { _id: email },
      {
        $set: { role: 'admin', authUserId: user._id, revokedAt: null },
        $setOnInsert: { invitedAt: new Date(), acceptedAt: new Date() },
      },
      { upsert: true },
    );
    console.log(`Administrator ready: ${email}. Sign in with Google at /admin/login.`);
  }
} finally {
  await disconnectDatabase();
}
