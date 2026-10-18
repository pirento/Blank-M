/**
 * OAuth login state for the read-only Upstox and Fyers connections. As in the
 * Zerodha flow, the state sent to the broker is random and single use: its
 * hash is stored as a BrokerOAuthState marker bound to the member and also in
 * the member's app session, so the callback only completes in the same
 * signed-in browser, for the same member, within ten minutes, once.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { BrokerOAuthState } from '../../models/index.js';
import { HttpError } from '../errors.js';

const STATE_TTL_MS = 10 * 60_000;
const STATE = /^[A-Za-z0-9_-]{43}$/;

const stateHash = (provider, state) =>
  createHash('sha256').update(`blank-broker-oauth-v1:${provider}:${state}`).digest('hex');
const invalid = () =>
  new HttpError('The broker login expired or does not match this browser. Start again.', 400);

/** The app's origin from APP_URL, or null when APP_URL is not an http(s) URL. */
export function appOrigin() {
  try {
    const url = new URL(env.appUrl);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

/** The redirect URI registered with the broker: <APP_URL origin>/api/<provider>/callback. */
export function callbackUrl(provider) {
  const origin = appOrigin();
  return origin ? `${origin}/api/${provider}/callback` : null;
}

/** Starts a login for the signed-in member: records a fresh state and returns it. */
export async function beginOAuth(req, provider) {
  const state = randomBytes(32).toString('base64url');
  const hash = stateHash(provider, state);
  await BrokerOAuthState.create({
    _id: hash,
    userId: req.member.userId,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  req.session.brokerOAuth = { ...req.session.brokerOAuth, [provider]: hash };
  return state;
}

/**
 * Checks a callback's state against this browser's session and the signed-in
 * member, and uses it up. Throws 400 when it does not match, was used or expired.
 */
export async function finishOAuth(req, provider, userId, state) {
  const expected = req.session?.brokerOAuth?.[provider];
  if (expected) delete req.session.brokerOAuth[provider];
  if (typeof state !== 'string' || !STATE.test(state) || typeof expected !== 'string')
    throw invalid();
  const hash = stateHash(provider, state);
  if (hash.length !== expected.length || !timingSafeEqual(Buffer.from(hash), Buffer.from(expected)))
    throw invalid();
  const marker = await BrokerOAuthState.findOneAndUpdate(
    { _id: hash, userId, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  ).lean();
  if (!marker) throw invalid();
}
