/**
 * Express sessions stored in MongoDB (connect-mongo) and the session cookie settings.
 */
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import { env } from '../config/env.js';

export const SESSION_COOKIE = 'blank.sid';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Server-side sessions in MongoDB. Stored as objects (not strings) so a
 * membership revocation can delete every session belonging to one account.
 */
export function sessionMiddleware({ store } = {}) {
  const secure = env.isProduction || /^https:/i.test(env.appUrl);
  return session({
    name: SESSION_COOKIE,
    secret: env.sessionSecret || 'blank-development-session-secret-change-me',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: env.trustProxy > 0,
    store:
      store ??
      MongoStore.create({
        client: mongoose.connection.getClient(),
        collectionName: 'sessions',
        stringify: false,
        ttl: SESSION_MAX_AGE_MS / 1000,
        autoRemove: 'native',
        // Refresh a session's expiry at most once an hour, not on every request.
        touchAfter: 3600,
      }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: SESSION_MAX_AGE_MS,
    },
  });
}
