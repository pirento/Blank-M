/**
 * Zerodha login flow security: configuration, origin and method checks, the
 * signed OAuth state cookie and callback validation.
 */
import { createHash, randomBytes } from 'node:crypto';
import { assertBrokerEncryptionWriteReady, decryptSecret, encryptSecret } from '../crypto.js';

import { ServerConfigurationError } from '../errors.js';
import { BrokerOAuthState } from '../../models/index.js';
import { authenticatedApi } from '../../middleware/auth.js';
import { validateAppSession } from '../auth/app-sessions.js';
import { MarketDataError } from '../market/types.js';

const COOKIE_BROWSER = '__Host-blank_kite_browser';
const COOKIE_FLOW = '__Host-blank_kite_flow';
const COOKIE_PENDING = '__Host-blank_kite_pending';
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_TTL_MS = 120_000;

const invalid = () =>
  new MarketDataError(
    'The broker connection expired or does not match this browser. Start again.',
    400,
  );
const hash = (value) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');

/**
 * The app origin and required sign-in freshness (BROKER_FRESH_AUTH_SECONDS, 60–600 s, default 300).
 * Throws MarketDataError 503 unless APP_URL is a bare https origin and KITE_REDIRECT_URI is its
 * /api/kite/callback.
 */
export function brokerConfiguration() {
  try {
    const rawApp = process.env.APP_URL || '';
    const app = new URL(rawApp);
    const callback = process.env.KITE_REDIRECT_URI || '';
    const freshnessSeconds = Number(process.env.BROKER_FRESH_AUTH_SECONDS ?? '300');
    if (
      app.protocol !== 'https:' ||
      app.username ||
      app.password ||
      app.search ||
      app.hash ||
      app.pathname !== '/' ||
      (rawApp !== app.origin && rawApp !== `${app.origin}/`) ||
      callback !== `${app.origin}/api/kite/callback` ||
      !Number.isInteger(freshnessSeconds) ||
      freshnessSeconds < 60 ||
      freshnessSeconds > 600
    )
      throw new Error();
    return { origin: app.origin, freshnessMs: freshnessSeconds * 1000 };
  } catch {
    throw new MarketDataError(
      'Secure broker connection settings are not configured correctly.',
      503,
    );
  }
}

/** Sets no-store, no-referrer and nosniff headers on a broker response. */
export function secureBrokerResponse(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/**
 * Applies the secure broker headers and answers 405 when the request method is not `method`.
 * Returns whether the handler should continue.
 */
export function requireBrokerMethod(req, res, method) {
  secureBrokerResponse(res);
  res.setHeader('Allow', method);
  if (req.method !== method) {
    res.status(405).json({ error: `Method not allowed. Use ${method}.` });
    return false;
  }
  return true;
}

/** No Host/forwarded-header inference and no missing-Origin exceptions. */
export function requireBrokerOrigin(req) {
  if (
    req.headers.origin !== brokerConfiguration().origin ||
    (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
  ) {
    throw new MarketDataError('The broker request must come from this application.', 403);
  }
}

/**
 * The broker flow context for a signed-in member whose server session is active and whose sign-in
 * is recent enough, expiring at the freshness limit or session cookie expiry. Throws
 * MarketDataError 401 or 503 otherwise.
 */
export async function authenticateBrokerRequest(req) {
  const auth = authenticatedApi(req);
  const now = Date.now();
  const config = brokerConfiguration();
  const session = auth.session;
  // Only the server-side session record establishes identity and sign-in time.
  if (
    typeof session.sessionId !== 'string' ||
    !UUID.test(session.sessionId) ||
    !UUID.test(auth.user._id) ||
    !['password', 'oauth'].includes(session.method)
  ) {
    throw new MarketDataError('Your app session could not be verified. Sign in again.', 401);
  }
  const authenticatedAt =
    Number.isInteger(session.authenticatedAt) && session.authenticatedAt <= now
      ? session.authenticatedAt
      : 0;
  if (!authenticatedAt || now - authenticatedAt >= config.freshnessMs) {
    throw new MarketDataError(
      'Sign out of Blank, sign in again, and restart the broker connection. A recent app sign-in is required.',
      401,
    );
  }
  let active;
  try {
    active = await validateAppSession(auth.user._id, session.sessionId);
  } catch {
    throw new MarketDataError('The secure broker session check is unavailable.', 503);
  }
  if (!active)
    throw new MarketDataError('Your app session is no longer active. Sign in again.', 401);
  const cookieExpiry = req.session?.cookie?.expires
    ? new Date(req.session.cookie.expires).getTime()
    : now + config.freshnessMs;
  return {
    userId: auth.user._id,
    sessionId: session.sessionId,
    authenticatedAt,
    expiresAt: Math.min(authenticatedAt + config.freshnessMs, cookieExpiry),
  };
}

function cookie(req, name) {
  const entries = (req.headers.cookie || '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.split('=', 1)[0] === name);
  if (entries.length !== 1) throw invalid();
  const value = entries[0].slice(name.length + 1);
  if (!value || value.length > 3800) throw invalid();
  return value;
}

function putCookies(res, cookies) {
  // A handler may clear old cookies before setting a new flow. Preserve all entries.
  const previous = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [
    ...(Array.isArray(previous)
      ? previous.map(String)
      : typeof previous === 'string'
        ? [previous]
        : []),
    ...cookies,
  ]);
}
function serializeCookie(name, value, seconds) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(seconds))}`;
}
function seal(value) {
  return Buffer.from(JSON.stringify(encryptSecret(JSON.stringify(value)))).toString('base64url');
}
function unseal(req, name, purpose) {
  try {
    const envelope = JSON.parse(Buffer.from(cookie(req, name), 'base64url').toString('utf8'));
    const value = JSON.parse(decryptSecret(envelope));
    const now = Date.now();
    if (
      value.purpose !== purpose ||
      !UUID.test(value.userId) ||
      !UUID.test(value.sessionId) ||
      typeof value.authenticatedAt !== 'number' ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= now ||
      value.authenticatedAt > now ||
      value.expiresAt > value.authenticatedAt + brokerConfiguration().freshnessMs ||
      typeof value.browserHash !== 'string' ||
      value.browserHash !== hash(browserSecret(req))
    )
      throw invalid();
    return value;
  } catch {
    throw invalid();
  }
}
function browserSecret(req) {
  const value = cookie(req, COOKIE_BROWSER);
  if (!NONCE.test(value)) throw invalid();
  return value;
}
function stateHash(purpose, nonce, browser, context) {
  return hash(
    JSON.stringify(['blank-kite-v1', purpose, nonce, browser, context.userId, context.sessionId]),
  );
}
async function createMarker(stateHash, context) {
  try {
    await BrokerOAuthState.create({
      _id: stateHash,
      userId: context.userId,
      expiresAt: new Date(context.expiresAt),
    });
  } catch {
    throw new MarketDataError('Could not start the secure broker connection.', 503);
  }
  if (context.expiresAt <= Date.now()) throw invalid();
}
async function consumeMarker(stateHash, context) {
  let marker = null;
  try {
    marker = await BrokerOAuthState.findOneAndUpdate(
      { _id: stateHash, usedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
      { new: true },
    ).lean();
  } catch {
    throw invalid();
  }
  if (!marker || marker.userId !== context.userId || context.expiresAt <= Date.now())
    throw invalid();
}
/** Expires all three Zerodha flow cookies (browser, flow and pending). */
export function clearBrokerCookies(res) {
  putCookies(
    res,
    [COOKIE_BROWSER, COOKIE_FLOW, COOKIE_PENDING].map((name) => serializeCookie(name, '', 0)),
  );
}

/**
 * Starts a Zerodha login: records a one-use state marker and sets the browser-binding and sealed
 * flow cookies. Returns the OAuth state to send to Kite.
 */
export async function beginBrokerFlow(req, res) {
  const auth = await authenticateBrokerRequest(req);
  assertBrokerEncryptionWriteReady();
  const browser = random();
  const state = random();
  const context = { ...auth, purpose: 'kite-flow', browserHash: hash(browser) };
  await createMarker(stateHash('callback', state, browser, context), context);
  const seconds = (context.expiresAt - Date.now()) / 1000;
  clearBrokerCookies(res);
  putCookies(res, [
    serializeCookie(COOKIE_BROWSER, browser, seconds),
    serializeCookie(COOKIE_FLOW, seal(context), seconds),
  ]);
  return state;
}

/** The single value of a raw callback query parameter. Throws when it is missing or repeated. */
export function callbackField(req, name) {
  // Inspect the raw query, because some framework parsers collapse duplicate keys.
  if (!req.url) throw invalid();
  const values = new URL(req.url, brokerConfiguration().origin).searchParams.getAll(name);
  if (values.length !== 1) throw invalid();
  return values[0];
}

/**
 * Validates the Kite callback against the flow cookie and its one-use state marker, then swaps the
 * flow cookie for a short-lived (≤ 120 s) sealed pending cookie holding the request token. Clears
 * all flow cookies on failure.
 */
export async function stageBrokerCallback(req, res) {
  const config = brokerConfiguration();
  if (
    req.headers.host !== new URL(config.origin).host ||
    !req.url ||
    req.url.split('?', 1)[0] !== '/api/kite/callback'
  )
    throw invalid();
  const state = callbackField(req, 'state');
  const requestToken = callbackField(req, 'request_token');
  if (!NONCE.test(state) || !/^[A-Za-z0-9_-]{1,512}$/.test(requestToken)) throw invalid();
  const context = unseal(req, COOKIE_FLOW, 'kite-flow');
  const browser = browserSecret(req);
  await consumeMarker(stateHash('callback', state, browser, context), context);
  const pending = {
    ...context,
    purpose: 'kite-pending',
    requestToken,
    nonce: random(),
    expiresAt: Math.min(context.expiresAt, Date.now() + PENDING_TTL_MS),
  };
  try {
    await createMarker(stateHash('complete', pending.nonce, browser, pending), pending);
    putCookies(res, [
      serializeCookie(COOKIE_FLOW, '', 0),
      serializeCookie(COOKIE_PENDING, seal(pending), (pending.expiresAt - Date.now()) / 1000),
    ]);
  } catch (error) {
    // This callback already proved and consumed the matching flow.
    clearBrokerCookies(res);
    throw error;
  }
}

/**
 * Consumes the pending callback for the same signed-in session and returns the request token with
 * its authorization expiry. Throws MarketDataError 400 when the pending result is invalid, reused
 * or expired.
 */
export async function consumePendingBrokerResult(req) {
  const auth = await authenticateBrokerRequest(req);
  const pending = unseal(req, COOKIE_PENDING, 'kite-pending');
  if (
    auth.userId !== pending.userId ||
    auth.sessionId !== pending.sessionId ||
    !NONCE.test(pending.nonce) ||
    !/^[A-Za-z0-9_-]{1,512}$/.test(pending.requestToken) ||
    pending.expiresAt > Date.now() + PENDING_TTL_MS
  )
    throw invalid();
  await consumeMarker(stateHash('complete', pending.nonce, browserSecret(req), pending), pending);
  const authorizationExpiresAt = new Date(Math.min(pending.expiresAt, auth.expiresAt));
  if (authorizationExpiresAt.getTime() <= Date.now()) throw invalid();
  return {
    userId: auth.userId,
    sessionId: auth.sessionId,
    requestToken: pending.requestToken,
    authorizationExpiresAt,
  };
}

/**
 * Sends a broker-flow error as JSON with a safe status and message; unexpected errors become a
 * generic 500.
 */
export function brokerError(res, error) {
  const status =
    error instanceof MarketDataError
      ? error.status
      : error instanceof ServerConfigurationError
        ? 503
        : typeof error === 'object' &&
            error &&
            'status' in error &&
            [401, 403].includes(Number(error.status))
          ? Number(error.status)
          : 500;
  res.status(status).json({
    error:
      error instanceof ServerConfigurationError
        ? 'Secure broker configuration needs an administrator update before connecting.'
        : error instanceof MarketDataError || (status < 500 && error instanceof Error)
          ? error.message
          : 'Could not complete the secure broker connection. Start again.',
  });
}
