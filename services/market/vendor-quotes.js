/**
 * Live prices from the platform's market data vendor (TrueData), read by web
 * processes. The feed process (scripts/market-feed.js) writes LiveQuote; here we
 * register the symbols pages are showing (LiveSubscription) and poll LiveQuote
 * once a second for all of them together.
 */
import { LiveQuote, LiveSubscription } from '../../models/index.js';
import { createLogger, errorName } from '../logger.js';
import { isTrueDataConfigured } from './truedata/config.js';

const log = createLogger('vendor-quotes');
const POLL_MS = 1000;
const RENEW_MS = 20_000;
const SUBSCRIPTION_MS = 60_000;
/** A quote older than this is not "live" for getQuote. */
const FRESH_MS = 5 * 60_000;

/** symbol → Set of onTick listeners on this process. */
const watchers = new Map();
const lastSeen = new Map();
let pollTimer = null;
let renewTimer = null;

/** Tells the feed which symbols to stream (for the next minute). */
async function register(symbols) {
  if (!symbols.length) return;
  const expiresAt = new Date(Date.now() + SUBSCRIPTION_MS);
  await LiveSubscription.bulkWrite(
    symbols.map((symbol) => ({
      updateOne: { filter: { _id: symbol }, update: { $set: { expiresAt } }, upsert: true },
    })),
    { ordered: false },
  );
}

async function poll() {
  const symbols = [...watchers.keys()];
  if (!symbols.length) return;
  const rows = await LiveQuote.find({ _id: { $in: symbols } }).lean();
  for (const row of rows) {
    const at = row.at.getTime();
    if (lastSeen.get(row._id) === at) continue;
    lastSeen.set(row._id, at);
    for (const onTick of watchers.get(row._id) ?? []) onTick({ symbol: row._id, price: row.price });
  }
}

function startTimers() {
  if (pollTimer) return;
  pollTimer = setInterval(
    () => poll().catch((error) => log.warn('poll failed', { error: errorName(error) })),
    POLL_MS,
  );
  renewTimer = setInterval(() => register([...watchers.keys()]).catch(() => undefined), RENEW_MS);
}

function stopTimersIfIdle() {
  if (watchers.size || !pollTimer) return;
  clearInterval(pollTimer);
  clearInterval(renewTimer);
  pollTimer = renewTimer = null;
}

/**
 * Calls `onTick({ symbol, price })` with vendor prices for `symbols`; resolves to an unsubscribe
 * function, or null when no vendor is set up (the caller falls back to the member's broker).
 */
export async function subscribeVendorQuotes(symbols, { onTick }) {
  if (!isTrueDataConfigured()) return null;
  const wanted = [...new Set(symbols)];
  for (const symbol of wanted) {
    if (!watchers.has(symbol)) watchers.set(symbol, new Set());
    watchers.get(symbol).add(onTick);
    lastSeen.delete(symbol); // send the current price straight away
  }
  await register(wanted);
  startTimers();
  return () => {
    for (const symbol of wanted) {
      watchers.get(symbol)?.delete(onTick);
      if (!watchers.get(symbol)?.size) watchers.delete(symbol);
    }
    stopTimersIfIdle();
  };
}

/** The vendor's latest price for one symbol as a quote, or null (none recent, or no vendor). */
export async function vendorQuote(symbol) {
  if (!isTrueDataConfigured()) return null;
  await register([symbol]);
  const row = await LiveQuote.findById(symbol).lean();
  if (!row || Date.now() - row.at.getTime() > FRESH_MS) return null;
  return { symbol, price: row.price, previousClose: null, currency: 'INR', source: 'truedata' };
}
