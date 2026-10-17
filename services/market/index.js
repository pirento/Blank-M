/**
 * Market data entry point: Zerodha Kite first, Yahoo Finance as the fallback
 * for quotes and price history.
 */
import { kiteProvider } from './kite.js';
import { yahooProvider } from './yahoo.js';
import { MarketDataError } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('market-data');

export * from './types.js';
export { yahooProvider, toYahooSymbol } from './yahoo.js';
export { instrumentCount, parseInstruments, refreshInstruments } from './instruments.js';
export {
  kiteProvider,
  buildAuthorizeUrl,
  connectionStatus,
  exchangeRequestToken,
  isKiteConfigured,
  nextTokenExpiry,
  requestTokenChecksum,
  saveConnection,
} from './kite.js';

/**
 * Whether a provider error should fall back to Yahoo: everything except a MarketDataError with
 * status 400.
 */
export function shouldFallBack(error) {
  return !(error instanceof MarketDataError) || error.status !== 400;
}

/**
 * A quote from Zerodha when the member's connection is available, otherwise (or on a
 * fallback-worthy error) from Yahoo.
 */
export async function getQuote(symbol, userId) {
  try {
    if (await kiteProvider.isAvailable(userId)) {
      return await kiteProvider.fetchQuote(symbol, userId);
    }
  } catch (error) {
    if (!shouldFallBack(error)) throw error;
    log.warn('Zerodha quote unavailable; using Yahoo');
  }
  return yahooProvider.fetchQuote(symbol, userId);
}

/**
 * Price history from Zerodha when the member's connection is available, otherwise (or on a
 * fallback-worthy error) from Yahoo.
 */
export async function getHistory(symbol, fromSeconds, toSeconds, interval, userId) {
  try {
    if (await kiteProvider.isAvailable(userId)) {
      return await kiteProvider.fetchHistory(symbol, fromSeconds, toSeconds, interval, userId);
    }
  } catch (error) {
    if (!shouldFallBack(error)) throw error;
    log.warn('Zerodha history unavailable; using Yahoo');
  }
  return yahooProvider.fetchHistory(symbol, fromSeconds, toSeconds, interval, userId);
}
