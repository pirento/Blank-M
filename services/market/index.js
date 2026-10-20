/**
 * Market data entry point: the platform's data vendor (TrueData) when the
 * administrator set one up, then the member's Zerodha Kite, then Yahoo Finance.
 */
import { kiteProvider } from './kite.js';
import { isTrueDataConfigured } from './truedata/config.js';
import { trueDataProvider } from './truedata/history.js';
import { vendorQuote } from './vendor-quotes.js';
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
 * A quote from the data vendor's live feed when there is a recent one, else from Zerodha when the
 * member's connection is available, otherwise (or on a fallback-worthy error) from Yahoo.
 */
export async function getQuote(symbol, userId) {
  try {
    const live = await vendorQuote(symbol);
    if (live) return live;
  } catch {
    log.warn('vendor quote unavailable');
  }
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
 * Price history from the data vendor when set up, else Zerodha when the member's connection is
 * available, otherwise (or on a fallback-worthy error) from Yahoo.
 */
export async function getHistory(symbol, fromSeconds, toSeconds, interval, userId) {
  if (isTrueDataConfigured()) {
    try {
      return await trueDataProvider.fetchHistory(symbol, fromSeconds, toSeconds, interval);
    } catch (error) {
      if (!shouldFallBack(error)) throw error;
      log.warn('TrueData history unavailable; trying the next source');
    }
  }
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
