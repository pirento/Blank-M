/**
 * Read-only account data (profile, holdings, positions, orders, trades and
 * equity margins), always re-verifying the linked broker identity.
 */
import { MarketDataError } from '../types.js';
import { kiteFetch } from './client.js';
import { isKiteConfigured } from './config.js';
import { loadConnection } from './connection.js';

const PORTFOLIO_PATHS = new Set([
  '/portfolio/holdings',
  '/portfolio/positions',
  '/orders',
  '/trades',
]);

/** Read-only account data: verify membership, app session and retained broker identity throughout. */
export async function createVerifiedKiteReader(userId, assertAccess) {
  if (!isKiteConfigured()) throw new MarketDataError('Zerodha Kite is not configured.', 503);
  await assertAccess();
  const connection = await loadConnection(userId, true);
  if (!connection?.brokerUserId || connection.expiresAt.getTime() <= Date.now()) {
    throw new MarketDataError('Connect your Zerodha account in Settings first.', 409);
  }
  const assertUnchanged = async () => {
    await assertAccess();
    const current = await loadConnection(userId, true, false);
    if (
      !current ||
      current.expiresAt.getTime() <= Date.now() ||
      current.ciphertext !== connection.ciphertext ||
      current.brokerUserId !== connection.brokerUserId
    ) {
      throw new MarketDataError(
        'The broker session changed. Refresh the connection and try again.',
        409,
      );
    }
  };
  await assertUnchanged();
  const profile = await kiteFetch('/user/profile', connection, userId, 16 * 1024);

  if (profile?.status !== 'success' || profile.data?.user_id !== connection.brokerUserId) {
    throw new MarketDataError('The linked broker account identity could not be verified.', 409);
  }
  await assertUnchanged();
  return {
    assertUnchanged,
    async read(path) {
      // Keep this helper incapable of arbitrary paths or order mutations, even at runtime.
      if (!PORTFOLIO_PATHS.has(path)) throw new MarketDataError('Unsupported broker read.', 400);
      await assertUnchanged();
      const result = await kiteFetch(path, connection, userId, 2 * 1024 * 1024);
      await assertUnchanged();
      return result;
    },
  };
}

/** Verify the linked broker identity on every explicit balance read. Never falls back. */
export async function readBrokerBalance(userId) {
  if (!isKiteConfigured()) throw new MarketDataError('Zerodha Kite is not configured.', 503);
  const connection = await loadConnection(userId, true);
  if (!connection?.brokerUserId || connection.expiresAt.getTime() <= Date.now())
    throw new MarketDataError('Connect and verify your Zerodha account in Settings first.', 401);
  const assertUnchanged = async () => {
    const current = await loadConnection(userId, true, false);
    if (
      !current ||
      current.expiresAt.getTime() <= Date.now() ||
      current.ciphertext !== connection.ciphertext ||
      current.brokerUserId !== connection.brokerUserId
    )
      throw new MarketDataError(
        'The broker session changed during this balance read. Refresh the connection and read it again.',
        409,
      );
  };
  const profile = await kiteFetch('/user/profile', connection, userId);

  if (profile?.status !== 'success' || profile.data?.user_id !== connection.brokerUserId) {
    throw new MarketDataError(
      'The broker account identity could not be verified. No balance was read.',
      409,
    );
  }
  await assertUnchanged();
  const payload = await kiteFetch('/user/margins/equity', connection, userId);

  const value = payload?.data?.available?.live_balance;
  if (
    payload?.status !== 'success' ||
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) * 100 > Number.MAX_SAFE_INTEGER
  ) {
    throw new MarketDataError('Zerodha did not return a valid live equity balance.', 502);
  }
  await assertUnchanged();
  return {
    liveBalance: value,
    currency: 'INR',
    source: 'kite',
    fetchedAt: new Date().toISOString(),
  };
}
