/**
 * Zerodha Kite Connect configuration: API endpoints, request timeout and the
 * check that every credential needed for a broker connection is present.
 */
import { isDatabaseConnected } from '../../../config/database.js';

export const API_BASE = 'https://api.kite.trade';
export const LOGIN_BASE = 'https://kite.zerodha.com/connect/login';
export const TIMEOUT_MS = 12_000;

/**
 * Whether the Kite API key, secret, redirect URI and token encryption key are all set and the
 * database is connected.
 */
export function isKiteConfigured() {
  return Boolean(
    process.env.KITE_API_KEY &&
    process.env.KITE_API_SECRET &&
    process.env.KITE_REDIRECT_URI &&
    process.env.BROKER_TOKEN_ENCRYPTION_KEY &&
    isDatabaseConnected(),
  );
}
