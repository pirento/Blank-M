/**
 * Live prices from the platform's market data vendor (TrueData), read by web
 * processes. The feed process (scripts/market-feed.js) writes LiveQuote; here we
 * register the symbols pages are showing (LiveSubscription) and poll LiveQuote
 * once a second for all of them together.
 */
import { LiveQuote, LiveSubscription } from '../../models/index.js';
import { createLogger, errorName } from '../logger.js';
import { FEED_HEARTBEAT_ID, isTrueDataConfigured } from './truedata/config.js';

const log = createLogger('vendor-quotes');
const POLL_MS = 1000;
const RENEW_MS = 20_000;
const SUBSCRIPTION_MS = 60_000;
/** A one-off quote keeps its symbol on the feed this long (covers the 5-minute price checks). */
const QUOTE_SUBSCRIPTION_MS = 10 * 60_000;
/** The feed counts as running when its heartbeat (every 3 s) is younger than this. */
const FEED_ALIVE_MS = 15_000;
/** A streamed price older than this is not live (after the close, at weekends). */
const LIVE_TICK_MS = 2 * 60_000;

/** symbol → Set of onTick listeners on this process. */
const watchers = new Map();
const lastSeen = new Map();
let pollTimer = null;
let renewTimer = null;

/** Tells the feed which symbols to stream (for `forMs`); never shortens a longer registration. */
async function register(symbols, forMs = SUBSCRIPTION_MS) {
  if (!symbols.length) return;
  const expiresAt = new Date(Date.now() + forMs);
  await LiveSubscription.bulkWrite(
    symbols.map((symbol) => ({
      updateOne: { filter: { _id: symbol }, update: { $max: { expiresAt } }, upsert: true },
    })),
    { ordered: false },
  );
}

/** Whether the feed process is running and connected to TrueData. */
async function feedAlive() {
  const beat = await LiveQuote.findById(FEED_HEARTBEAT_ID, { at: 1 }).lean();
  return Boolean(beat && Date.now() - beat.at.getTime() < FEED_ALIVE_MS);
}

async function poll() {
  const symbols = [...watchers.keys()];
  if (!symbols.length) return;
  const rows = await LiveQuote.find({ _id: { $in: symbols } }).lean();
  for (const row of rows) {
    const at = row.at.getTime();
    if (lastSeen.get(row._id) === at) continue;
    lastSeen.set(row._id, at);
    // An old price (market closed) is not a live tick.
    if (Date.now() - at > LIVE_TICK_MS) continue;
    for (const onTick of watchers.get(row._id) ?? []) {
      onTick({ symbol: row._id, price: row.price, at });
    }
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
  // No feed running: let the caller use the member's own broker instead.
  if (!isTrueDataConfigured() || !(await feedAlive())) return null;
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

/**
 * The vendor's latest price for one symbol as a quote, or null (the caller uses another source):
 * only when the feed is running and was already following the symbol, so the price is current.
 * Registers the symbol so the next quote (e.g. the next 5-minute price check) can use the feed.
 */
export async function vendorQuote(symbol) {
  if (!isTrueDataConfigured()) return null;
  const [subscription, alive] = await Promise.all([
    LiveSubscription.findById(symbol, { expiresAt: 1 }).lean(),
    feedAlive(),
  ]);
  await register([symbol], QUOTE_SUBSCRIPTION_MS);
  // Followed for a few seconds already (registered earlier), so the feed has sent its price.
  const followed =
    subscription &&
    subscription.expiresAt.getTime() > Date.now() &&
    subscription.expiresAt.getTime() - Date.now() < QUOTE_SUBSCRIPTION_MS - 5000;
  if (!alive || !followed) return null;
  const row = await LiveQuote.findById(symbol).lean();
  if (!row) return null;
  return { symbol, price: row.price, previousClose: null, currency: 'INR', source: 'truedata' };
}
