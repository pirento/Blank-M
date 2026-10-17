import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import session from 'express-session';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../../config/database.js';
import { createApp } from '../../app.js';
import { AllowedUser, User } from '../../models/index.js';
import { hashPassword } from '../../services/auth/accounts.js';

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

export { request, session };
