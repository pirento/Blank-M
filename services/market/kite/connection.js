/**
 * Stored Kite sessions: load, decrypt, validate and expire the per-user
 * BrokerConnection row that holds the encrypted access token.
 */
import { decryptSecret } from '../../crypto.js';
import { BrokerConnection } from '../../../models/index.js';
import { MarketDataError } from '../types.js';
import { isKiteConfigured } from './config.js';

export class BrokerCredentialError extends MarketDataError {
  constructor() {
    super(
      'Stored Zerodha credentials cannot be read. Reconnect the same account in Settings.',
      409,
    );
  }
}

/**
 * The member's stored Kite session as `{ ciphertext, accessToken, expiresAt, brokerUserId }`, or
 * null when Kite is not configured or no usable row exists. The token is decrypted only while
 * unexpired and when `decryptToken` is set (BrokerCredentialError if it cannot be read). With
 * `strict`, lookup and integrity problems throw MarketDataError 503 instead of returning null.
 */
export async function loadConnection(userId, strict = false, decryptToken = true) {
  if (!isKiteConfigured()) return null;
  let connection = null;
  let error = null;
  try {
    const row = await BrokerConnection.findOne({ userId, provider: 'kite' }).lean();
    connection = row
      ? {
          access_token_ciphertext: row.accessTokenCiphertext,
          access_token_iv: row.accessTokenIv,
          access_token_tag: row.accessTokenTag,
          expires_at: row.expiresAt,
          broker_user_id: row.brokerUserId,
        }
      : null;
  } catch (found) {
    error = found;
  }
  if (strict && error) {
    throw new MarketDataError('Could not verify the stored broker session. Try again.', 503);
  }
  if (error || !connection) return null;
  const expiresAt = new Date(connection.expires_at);
  if (!Number.isFinite(expiresAt.getTime())) {
    if (strict) throw new MarketDataError('The stored broker session could not be verified.', 503);
    return null;
  }
  if (
    strict &&
    expiresAt.getTime() > Date.now() &&
    (typeof connection.access_token_ciphertext !== 'string' || !connection.access_token_ciphertext)
  ) {
    throw new MarketDataError('The stored broker session could not be verified.', 503);
  }
  let accessToken = '';
  if (decryptToken && expiresAt.getTime() > Date.now()) {
    try {
      accessToken = decryptSecret({
        ciphertext: connection.access_token_ciphertext,
        iv: connection.access_token_iv,
        tag: connection.access_token_tag,
      });
    } catch {
      throw new BrokerCredentialError();
    }
  }
  return {
    ciphertext: connection.access_token_ciphertext,
    accessToken,
    expiresAt,
    brokerUserId: connection.broker_user_id || null,
  };
}

/**
 * Blanks the stored token and expires the session, but only if the row still holds `ciphertext` (a
 * newer connection is left alone). Throws MarketDataError 503 when the write fails.
 */
export async function invalidateConnection(userId, ciphertext) {
  if (!ciphertext) return;
  try {
    await BrokerConnection.updateOne(
      { userId, provider: 'kite', accessTokenCiphertext: ciphertext },
      {
        $set: {
          accessTokenCiphertext: '',
          accessTokenIv: '',
          accessTokenTag: '',
          expiresAt: new Date(),
        },
      },
    );
  } catch {
    throw new MarketDataError('Could not expire the broker session safely.', 503);
  }
}

/** The member's unexpired Kite session with its decrypted token, or null. */
export async function activeConnection(userId) {
  if (!userId) return null;
  const connection = await loadConnection(userId);
  if (!connection || connection.expiresAt.getTime() <= Date.now()) return null;
  return connection;
}
