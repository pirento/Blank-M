/**
 * MongoDB connection (Mongoose): connect, disconnect and connection status.
 */
import mongoose from 'mongoose';
import { env } from './env.js';

mongoose.set('strictQuery', true);

let connecting = null;

/** One shared connection per process. Models are registered on import. */
export async function connectDatabase(uri = env.mongoUri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  connecting ??= mongoose
    .connect(uri, {
      serverSelectionTimeoutMS: 10_000,
      autoIndex: true,
      // If MongoDB is slow, fail a request after a while instead of letting every request pile up.
      maxPoolSize: 50,
      waitQueueTimeoutMS: 5_000,
      socketTimeoutMS: 30_000,
    })
    .finally(() => {
      connecting = null;
    });
  await connecting;
  await ensureSessionIndexes();
  return mongoose.connection;
}

/**
 * The session store (connect-mongo) has no model, so mongoose never indexes
 * it. Listing, revoking and validating a member's sessions filter on these.
 */
async function ensureSessionIndexes() {
  await mongoose.connection.db
    .collection('sessions')
    .createIndex(
      { 'session.auth.userId': 1, 'session.auth.sessionId': 1 },
      { name: 'auth_user_session', sparse: true },
    );
}

/** Closes the shared Mongoose connection (server shutdown, scripts and tests). */
export async function disconnectDatabase() {
  await mongoose.disconnect();
}

/** True while the Mongoose connection is open (readyState 1). */
export function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

/** Native driver handle for GridFS buckets and session-store maintenance. */
export function nativeDb() {
  if (!isDatabaseConnected()) {
    throw Object.assign(new Error('The database is not connected.'), { status: 503 });
  }
  return mongoose.connection.db;
}
