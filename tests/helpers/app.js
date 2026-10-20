import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import session from 'express-session';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../../config/database.js';
import { createApp } from '../../app.js';
import { AllowedUser, User } from '../../models/index.js';
import { hashPassword, issueAdminSetupCode } from '../../services/auth/accounts.js';
import { currentStep, totpCode } from '../../services/auth/totp.js';

let server = null;

/** Start an isolated in-memory MongoDB and the Express app. */
export async function startTestApp() {
  server ??= await MongoMemoryServer.create();
  await connectDatabase(server.getUri(`blank-test-${process.pid}-${Date.now()}`));
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
  const app = createApp();
  return app;
}

export async function stopTestApp() {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await disconnectDatabase();
  await server?.stop();
  server = null;
}

export async function resetDatabase() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

/** Create an invited, confirmed member (or admin) with a password. */
export async function createMember({
  email = 'member@example.com',
  password = 'correct horse battery',
  role = 'member',
} = {}) {
  const user = await User.create({
    email,
    role,
    status: 'active',
    passwordHash: await hashPassword(password),
    emailConfirmedAt: new Date(),
  });
  await AllowedUser.create({
    _id: email,
    role,
    authUserId: user._id,
    acceptedAt: new Date(),
  });
  return { user, password };
}

/** A supertest agent that is signed in and knows its CSRF token. */
export async function signIn(app, { email, password }) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(page.text)?.[1];
  const login = await agent
    .post('/auth/login')
    .set('X-CSRF-Token', csrf)
    .send({ identifier: email, password });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.text}`);
  return { agent, csrf: login.body.csrfToken };
}

/**
 * Adds and verifies an authenticator for a signed-in session (`{ agent, csrf }` from signIn), so
 * the session is aal2. Administrators get their one-time setup code straight from the service.
 */
export async function verifyAuthenticator(signedIn, user) {
  const post = (path, body) =>
    signedIn.agent.post(path).set('X-CSRF-Token', signedIn.csrf).send(body);
  const setupCode = user.role === 'admin' ? await issueAdminSetupCode(user) : undefined;
  const enrol = await post('/auth/mfa/enroll', { setupCode });
  if (enrol.status !== 201) throw new Error(`enroll failed: ${enrol.status} ${enrol.text}`);
  const verify = await post('/auth/mfa/verify', {
    factorId: enrol.body.id,
    code: totpCode(enrol.body.secret, currentStep()),
  });
  if (verify.status !== 200) throw new Error(`verify failed: ${verify.status} ${verify.text}`);
}

/**
 * Signs an administrator in the only way administrators can: Google (faked here) and then their
 * authenticator (added on first sign-in). Returns `{ agent, csrf }` with an aal2 session.
 */
export async function signInAdmin(app, user, { authenticator = true } = {}) {
  const realFetch = globalThis.fetch;
  const previous = {
    GOOGLE_AUTH_ENABLED: process.env.GOOGLE_AUTH_ENABLED,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  };
  Object.assign(process.env, {
    GOOGLE_AUTH_ENABLED: 'true',
    GOOGLE_CLIENT_ID: previous.GOOGLE_CLIENT_ID || 'test-client',
    GOOGLE_CLIENT_SECRET: previous.GOOGLE_CLIENT_SECRET || 'test-secret',
  });
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'google-token' });
    }
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return Response.json({ email: user.email, email_verified: true, sub: `sub-${user._id}` });
    }
    return realFetch(url, options);
  };
  const agent = request.agent(app);
  try {
    const started = await agent.get('/auth/google?for=admin');
    const state = new URL(started.headers.location).searchParams.get('state');
    const done = await agent.get(`/auth/google/callback?state=${state}&code=test`);
    if (done.headers.location !== '/admin')
      throw new Error(`admin sign-in failed: ${done.headers.location}`);
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // Any page carries the session's CSRF token.
  const page = await agent.get('/terms');
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(page.text)?.[1];
  const session = { agent, csrf };
  if (authenticator) await verifyAuthenticator(session, user);
  return session;
}

export { request, session };
