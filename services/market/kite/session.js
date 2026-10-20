/**
 * Kite login lifecycle: authorize URL, request-token exchange (OAuth), storing
 * the encrypted session, disconnecting it and reporting connection status.
 */
import { createHash } from 'node:crypto';
import { assertBrokerEncryptionWriteReady, encryptSecret } from '../../crypto.js';
import { BrokerConnection } from '../../../models/index.js';
import { validateAppSession } from '../../auth/app-sessions.js';
import { instrumentCount } from '../instruments.js';
import { MarketDataError } from '../types.js';
import { API_BASE, LOGIN_BASE, TIMEOUT_MS, isKiteConfigured } from './config.js';
import { BrokerCredentialError, invalidateConnection, loadConnection } from './connection.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The Kite request-token checksum: SHA-256 of API key + request token + API secret. Throws 503 when
 * unconfigured.
 */
export function requestTokenChecksum(requestToken) {
  const key = process.env.KITE_API_KEY;
  const secret = process.env.KITE_API_SECRET;
  if (!key || !secret) throw new MarketDataError('Zerodha Kite is not configured.', 503);
  return sha256(`${key}${requestToken}${secret}`);
}

/**
 * When a Kite access token expires: the next 06:00 IST after `now` (a login at 02:00 IST expires
 * four hours later, not the next day).
 */
export function nextTokenExpiry(now = new Date()) {
  const istOffset = 330 * 60_000;
  const ist = new Date(now.getTime() + istOffset);
  let expiry = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 0, 0);
  if (expiry <= ist.getTime()) expiry += 24 * 60 * 60_000;
  return new Date(expiry - istOffset);
}

/** The custom callback field follows Kite's documented redirect_params protocol. */
export function buildAuthorizeUrl(state) {
  if (!isKiteConfigured()) throw new MarketDataError('Zerodha Kite is not configured.', 503);
  const url = new URL(LOGIN_BASE);
  url.searchParams.set('v', '3');
  url.searchParams.set('api_key', process.env.KITE_API_KEY);
  url.searchParams.set('redirect_params', new URLSearchParams({ state }).toString());
  return url.toString();
}

/**
 * Exchanges a Kite request token for an access token via POST /session/token and validates the
 * reply. Returns `{ accessToken, brokerUserId, expiresAt }`; throws MarketDataError 502/503/504 on
 * failure.
 */
export async function exchangeRequestToken(requestToken) {
  if (!isKiteConfigured()) throw new MarketDataError('Zerodha Kite is not configured.', 503);
  assertBrokerEncryptionWriteReady();
  const body = new URLSearchParams({
    api_key: process.env.KITE_API_KEY,
    request_token: requestToken,
    checksum: requestTokenChecksum(requestToken),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}/session/token`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Kite-Version': '3',
      },
      body,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);

    const token = payload?.data?.access_token;
    const brokerId = payload?.data?.user_id;
    if (
      !response.ok ||
      payload?.status !== 'success' ||
      typeof token !== 'string' ||
      !/^[A-Za-z0-9_-]{1,1024}$/.test(token) ||
      typeof brokerId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(brokerId) ||
      (payload?.data?.api_key !== undefined && payload.data.api_key !== process.env.KITE_API_KEY)
    ) {
      throw new MarketDataError('Zerodha did not return a valid account connection.', 502);
    }
    return { accessToken: token, brokerUserId: brokerId, expiresAt: nextTokenExpiry() };
  } catch (error) {
    if (error instanceof MarketDataError) throw error;
    if (controller.signal.aborted)
      throw new MarketDataError('Zerodha timed out. Start again.', 504);
    throw new MarketDataError('Could not reach Zerodha. Start again.', 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stores the encrypted Kite session, refreshing the existing row only for the same Zerodha user ID
 * (409 for another identity). The app session must stay active and within its authorization window
 * before and after the write; if it lapses afterwards the new token is expired again and 401 is
 * thrown.
 */
export async function saveConnection(userId, sessionId, authorizationExpiresAt, result) {
  if (
    !Number.isFinite(authorizationExpiresAt.getTime()) ||
    authorizationExpiresAt.getTime() <= Date.now()
  ) {
    throw new MarketDataError('The broker connection expired. Sign in again and restart.', 401);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(result.brokerUserId)) {
    throw new MarketDataError('Zerodha account identity is missing or invalid.', 502);
  }
  const encrypted = encryptSecret(result.accessToken);
  const sessionActive = async () =>
    authorizationExpiresAt.getTime() > Date.now() && (await validateAppSession(userId, sessionId));
  if (!(await sessionActive())) {
    throw new MarketDataError(
      'Your app session is no longer active or the connection expired. Sign in again and restart.',
      401,
    );
  }
  const values = {
    accessTokenCiphertext: encrypted.ciphertext,
    accessTokenIv: encrypted.iv,
    accessTokenTag: encrypted.tag,
    expiresAt: result.expiresAt,
    connectedAt: new Date(),
  };
  let stored;
  try {
    // An existing row may only be refreshed for the SAME broker identity.
    stored = await BrokerConnection.findOneAndUpdate(
      { userId, provider: 'kite', brokerUserId: result.brokerUserId },
      { $set: values },
      { new: true },
    );
    if (!stored) {
      const existing = await BrokerConnection.exists({ userId, provider: 'kite' });
      if (existing) {
        throw new MarketDataError(
          'This connection cannot replace the existing Zerodha account. Contact your administrator.',
          409,
        );
      }
      stored = await BrokerConnection.create({
        userId,
        provider: 'kite',
        brokerUserId: result.brokerUserId,
        ...values,
      });
    }
  } catch (error) {
    if (error instanceof MarketDataError) throw error;
    if (error?.code === 11000) {
      throw new MarketDataError(
        'This connection cannot replace the existing Zerodha account. Contact your administrator.',
        409,
      );
    }
    throw new MarketDataError('Could not store the Zerodha session. Try again.', 503);
  }
  // Freshness can elapse while writing; never leave an unauthorized session active.
  if (!(await sessionActive())) {
    await invalidateConnection(userId, encrypted.ciphertext).catch(() => undefined);
    throw new MarketDataError(
      'Your app session is no longer active or the connection expired. Sign in again and restart.',
      401,
    );
  }
}

/** Expire only the observed token. Retain the broker identity and never touch positions. */
export async function disconnectBrokerSession(userId) {
  if (!isKiteConfigured()) throw new MarketDataError('Zerodha Kite is not configured.', 503);
  const connection = await loadConnection(userId, true, false);
  if (connection && connection.expiresAt.getTime() > Date.now()) {
    await invalidateConnection(userId, connection.ciphertext);
  }
  const current = await loadConnection(userId, true, false);
  if (current && current.expiresAt.getTime() > Date.now()) {
    throw new MarketDataError(
      'An active broker session remains. Another connection may have completed; refresh and review it before disconnecting again.',
      409,
    );
  }
  return { connected: false, identityRetained: Boolean(current?.brokerUserId) };
}

/**
 * Kite status for the settings page: configured, connected, token expiry and stored instrument
 * count. Unreadable stored credentials report `reconnectRequired` instead of throwing.
 */
export async function connectionStatus(userId) {
  let connection;
  try {
    connection = await loadConnection(userId, true);
  } catch (error) {
    if (!(error instanceof BrokerCredentialError)) throw error;
    // Retain the identity row and expose reconnect controls after key rotation
    // or unreadable credentials; never classify a storage outage this way.
    return {
      configured: isKiteConfigured(),
      connected: false,
      expiresAt: null,
      instruments: await instrumentCount(),
      provider: 'kite',
      reconnectRequired: true,
    };
  }
  return {
    configured: isKiteConfigured(),
    connected: Boolean(connection && connection.expiresAt.getTime() > Date.now()),
    expiresAt: connection?.expiresAt.toISOString() || null,
    instruments: await instrumentCount(),
    provider: 'kite',
  };
}
