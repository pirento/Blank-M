/**
 * Local preview without installing MongoDB: starts an in-memory database,
 * seeds an administrator, then serves the app. Data is discarded on exit.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri('blank-dev');
process.env.APP_URL ||= `http://localhost:${process.env.PORT || 3000}`;

// End-to-end tests only (E2E_GOOGLE_STUB=1, set by playwright.config.js): a stand-in for Google's
// token and profile endpoints, so tests can sign in "with Google" offline. The browser side is
// faked in tests/e2e/helpers.js; the "code" Google returns is simply the email to sign in as.
// This file is the in-memory preview server and is never used in production.
if (process.env.E2E_GOOGLE_STUB === '1') {
  Object.assign(process.env, {
    GOOGLE_AUTH_ENABLED: 'true',
    GOOGLE_CLIENT_ID: 'e2e-client',
    GOOGLE_CLIENT_SECRET: 'e2e-secret',
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const code = new URLSearchParams(String(options?.body ?? '')).get('code');
      return Response.json({ access_token: code });
    }
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') {
      const email = String(options?.headers?.Authorization ?? '').replace('Bearer ', '');
      return Response.json({ email, email_verified: true, sub: `e2e-${email}` });
    }
    return realFetch(url, options);
  };
}

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
// End-to-end tests only: an administrator with a verified authenticator (E2E_MFA_ADMIN is
// "email:base32-secret"), for admin actions that need one.
if (process.env.E2E_MFA_ADMIN) {
  const { encryptMfaSecret } = await import('../services/crypto.js');
  const [mfaEmail, secret] = process.env.E2E_MFA_ADMIN.split(':');
  const user = await User.create({
    email: mfaEmail,
    role: 'admin',
    status: 'active',
    passwordHash: await hashPassword(password),
    emailConfirmedAt: new Date(),
    factors: [{ status: 'verified', verifiedAt: new Date(), secret: encryptMfaSecret(secret) }],
  });
  await AllowedUser.create({
    _id: mfaEmail,
    role: 'admin',
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
