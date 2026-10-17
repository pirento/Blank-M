/**
 * Local preview without installing MongoDB: starts an in-memory database,
 * seeds an administrator, then serves the app. Data is discarded on exit.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri('blank-dev');
process.env.APP_URL ||= `http://localhost:${process.env.PORT || 3000}`;

const { connectDatabase } = await import('../config/database.js');
const { AllowedUser, User } = await import('../models/index.js');
const { hashPassword } = await import('../services/auth/accounts.js');
await connectDatabase();
const email = process.env.ADMIN_EMAIL || 'admin@example.com';
const password = process.env.ADMIN_PASSWORD || 'blank-local-admin';
const admin = await User.create({
  email,
  role: 'admin',
  status: 'active',
  passwordHash: await hashPassword(password),
  emailConfirmedAt: new Date(),
});
await AllowedUser.create({
  _id: email,
  role: 'admin',
  authUserId: admin._id,
  acceptedAt: new Date(),
});
// Extra members for the end-to-end tests (comma-separated emails, same password).
// Each test file signs in as its own member so the per-account login limit is never reached.
for (const member of (process.env.E2E_MEMBERS || '').split(',').filter(Boolean)) {
  const user = await User.create({
    email: member,
    role: 'member',
    status: 'active',
    passwordHash: await hashPassword(password),
    emailConfirmedAt: new Date(),
  });
  await AllowedUser.create({
    _id: member,
    role: 'member',
    authUserId: user._id,
    acceptedAt: new Date(),
  });
}
console.log(`In-memory workspace: sign in as ${email} / ${password}`);
await import('../server.js');

const stop = async () => {
  await mongo.stop();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
