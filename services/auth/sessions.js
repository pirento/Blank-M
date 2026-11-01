/**
 * Signed-in sessions: start one (with a device label), end it, and list or end a member's other
 * sessions in the session store.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { nativeDb } from '../../config/database.js';

/** A coarse, human-readable device label; the raw user agent is not stored. */
export function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
}

/**
 * Regenerates the session (preventing fixation), stores the auth record with a new public session
 * ID and device label, and issues a fresh CSRF token. Resolves once the session is saved.
 */
export function establishSession(req, user, { method = 'password', recovery = false } = {}) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.auth = {
        userId: user._id,
        sessionId: randomUUID(),
        aal: 'aal1',
        method,
        authenticatedAt: Date.now(),
        passwordRecovery: recovery,
        device: describeDevice(req.get?.('user-agent')),
      };
      req.session.csrfToken = randomBytes(32).toString('base64url');
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

/**
 * Destroys the request's session, if any. Always resolves, even when the store reports an error.
 */
export function destroySession(req) {
  return new Promise((resolve) => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });
}

/** The member's signed-in sessions, newest activity first. */
export async function listUserSessions(userId, currentSessionId, maxAgeMs) {
  const rows = await nativeDb()
    .collection('sessions')
    .find({ 'session.auth.userId': userId }, { projection: { expires: 1, 'session.auth': 1 } })
    .toArray();
  return rows
    .filter((row) => row.session?.auth?.sessionId)
    .map((row) => {
      const auth = row.session.auth;
      const expires = row.expires ? new Date(row.expires).getTime() : null;
      return {
        id: auth.sessionId,
        device: auth.device || 'Unknown device',
        method: auth.method === 'oauth' ? 'Google' : 'Password',
        signedInAt: auth.authenticatedAt ? new Date(auth.authenticatedAt).toISOString() : null,
        lastActiveAt: expires && maxAgeMs ? new Date(expires - maxAgeMs).toISOString() : null,
        current: auth.sessionId === currentSessionId,
      };
    })
    .sort((left, right) => String(right.lastActiveAt).localeCompare(String(left.lastActiveAt)));
}

/** End one other session of this member, identified by its public session ID. */
export async function revokeUserSession(userId, sessionId) {
  const result = await nativeDb()
    .collection('sessions')
    .deleteOne({ 'session.auth.userId': userId, 'session.auth.sessionId': sessionId });
  return result.deletedCount === 1;
}

/** Revoke every server session for a user (membership revocation, password change). */
export async function revokeUserSessions(userId, exceptSessionId = null) {
  const filter = { 'session.auth.userId': userId };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  await nativeDb().collection('sessions').deleteMany(filter);
}
