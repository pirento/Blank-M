/**
 * Shared plumbing for the read-only broker connections (Dhan, Upstox, Fyers,
 * Angel One): one JSON request helper with a timeout, a response size limit
 * and member-safe error messages, and the encrypted token row each broker
 * keeps in BrokerConnection. Tokens are only ever decrypted to call the
 * broker; they are never sent to the browser and never logged.
 */
import { BrokerConnection } from '../../models/index.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { HttpError } from '../errors.js';
import { createLogger, errorName } from '../logger.js';

const log = createLogger('broker-api');
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Most rows read from any one broker list (trade book, positions, holdings). */
export const MAX_ROWS = 5000;

/** An HttpError meaning the broker refused the stored token (revoked or expired early). */
export function tokenRejectedError(message) {
  const error = new HttpError(message, 401);
  error.tokenRejected = true;
  return error;
}

/**
 * Calls a broker API and returns its parsed JSON. 401/403 throw a `tokenRejected`
 * HttpError with `rejected` as its message, 429 a rate-limit message, other
 * failures 502/504. A failed response's parsed body is kept on `error.body`
 * so a caller can show the broker's own reason (for example a wrong TOTP).
 */
export async function brokerRequest(
  label,
  url,
  { method = 'GET', headers = {}, body, rejected } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await fetch(url, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...headers },
      body,
    });
    text = await response.text();
  } catch (error) {
    log.warn('broker request failed', {
      broker: label,
      path: new URL(url).pathname,
      error: errorName(error),
    });
    throw new HttpError(`${label} could not be reached. Try again shortly.`, 504);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    throw tokenRejectedError(rejected ?? `${label} rejected the connection. Reconnect it.`);
  }
  if (response.status === 429)
    throw new HttpError(`${label} is rate limiting requests. Try again in a minute.`, 429);
  if (text.length > MAX_RESPONSE_BYTES)
    throw new HttpError(`${label} returned too much data.`, 502);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    if (!response.ok) throw new HttpError(`${label} returned ${response.status}.`, 502);
    throw new HttpError(`${label} returned an invalid response.`, 502);
  }
  if (!response.ok) {
    throw new HttpError(`${label} returned ${response.status}.`, 502, { body: payload });
  }
  return payload;
}

/** A broker's own error text, trimmed for display, or null. */
export function brokerMessage(payload) {
  const text = payload?.message ?? payload?.errors?.[0]?.message;
  return typeof text === 'string' && text.trim() ? text.trim().slice(0, 200) : null;
}

/** The rows of a broker list: an array of at most MAX_ROWS, null meaning none. Throws 502 otherwise. */
export function brokerRows(label, value, what) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS)
    throw new HttpError(`${label} returned an invalid ${what}.`, 502);
  return value.filter((row) => row && typeof row === 'object');
}

/** The first moment after `now` at hour:minute IST (when a broker's daily token lapses). */
export function nextIstTime(hour, minute, now = new Date()) {
  const offset = 330 * 60_000;
  const ist = new Date(now.getTime() + offset);
  let next = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hour, minute);
  if (next <= ist.getTime()) next += 24 * 60 * 60_000;
  return new Date(next - offset);
}

/** The member's row and decrypted token for `provider`, or null when none is usable. */
export async function loadBrokerToken(userId, provider) {
  const row = await BrokerConnection.findOne({ userId, provider }).lean();
  if (!row?.accessTokenCiphertext || row.expiresAt.getTime() <= Date.now()) return null;
  return {
    row,
    token: decryptSecret({
      ciphertext: row.accessTokenCiphertext,
      iv: row.accessTokenIv,
      tag: row.accessTokenTag,
    }),
  };
}

/** Connection state for the settings card; never includes the token. */
export async function brokerTokenStatus(userId, provider) {
  const row = await BrokerConnection.findOne({ userId, provider }).lean();
  const connected = Boolean(row?.accessTokenCiphertext) && row.expiresAt.getTime() > Date.now();
  return {
    connected,
    expired: Boolean(row?.accessTokenCiphertext) && !connected,
    clientId: row?.brokerUserId ?? null,
    expiresAt: row?.expiresAt?.toISOString() ?? null,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
  };
}

/**
 * Stores a token encrypted, bound to one broker account per member: another
 * account ID than the stored one is refused (409) until the member disconnects.
 */
export async function saveBrokerToken(userId, provider, label, { token, brokerUserId, expiresAt }) {
  const existing = await BrokerConnection.findOne({ userId, provider }).lean();
  if (existing?.brokerUserId && brokerUserId && existing.brokerUserId !== brokerUserId) {
    throw new HttpError(
      `This journal is linked to ${label} client ${existing.brokerUserId}. Disconnect it first to link another account.`,
      409,
    );
  }
  const encrypted = encryptSecret(token);
  await BrokerConnection.findOneAndUpdate(
    { userId, provider },
    {
      $set: {
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenIv: encrypted.iv,
        accessTokenTag: encrypted.tag,
        expiresAt,
        brokerUserId: brokerUserId ?? existing?.brokerUserId ?? null,
        connectedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

/** Forgets the token and the account binding. */
export async function forgetBrokerToken(userId, provider) {
  await BrokerConnection.deleteOne({ userId, provider });
}

/**
 * Runs `read(token)` with the member's stored token (409 when not connected).
 * A token the broker rejects is marked expired; the account binding is kept.
 */
export async function withBrokerToken(userId, provider, label, read) {
  const connection = await loadBrokerToken(userId, provider);
  if (!connection) throw new HttpError(`Connect your ${label} account in Settings first.`, 409);
  try {
    return await read(connection.token);
  } catch (error) {
    if (error.tokenRejected) {
      await BrokerConnection.updateOne(
        { userId, provider, accessTokenCiphertext: connection.row.accessTokenCiphertext },
        { $set: { expiresAt: new Date(0) } },
      );
    }
    throw error;
  }
}
