/**
 * The one TrueData WebSocket connection (TrueData allows one per login), run in
 * its own process by scripts/market-feed.js. It subscribes to the symbols web
 * processes registered in LiveSubscription and writes the latest price of each
 * to LiveQuote once a second, where every web process reads it.
 */
import { LiveQuote, LiveSubscription } from '../../../models/index.js';
import { createLogger, errorName } from '../../logger.js';
import {
  FEED_HEARTBEAT_ID,
  fromTrueDataSymbol,
  istToMillis,
  isTrueDataConfigured,
  toTrueDataSymbol,
} from './config.js';

const log = createLogger('truedata-feed');
const FLUSH_MS = 1000;
const SYNC_MS = 3000;
const SILENCE_MS = 20_000; // TrueData sends a heartbeat about every 5 s
const MAX_SYMBOLS = 500;

/**
 * Prices in one TrueData message: `[{ symbol, price, at }]`. `ids` maps TrueData's symbol IDs to our
 * symbols and is filled from subscribe replies (trades carry only the ID).
 */
export function readFeedMessage(message, ids) {
  if (Array.isArray(message?.symbollist)) {
    const ticks = [];
    for (const row of message.symbollist) {
      if (!Array.isArray(row)) continue;
      const symbol = fromTrueDataSymbol(String(row[0]));
      ids.set(String(row[1]), symbol);
      const price = Number(row[3]);
      const at = istToMillis(row[2]);
      if (price > 0 && Number.isFinite(at)) ticks.push({ symbol, price, at });
    }
    return ticks;
  }
  if (Array.isArray(message?.trade)) {
    const [id, time, ltp] = message.trade;
    const symbol = ids.get(String(id));
    const price = Number(ltp);
    const at = istToMillis(time);
    return symbol && price > 0 && Number.isFinite(at) ? [{ symbol, price, at }] : [];
  }
  return [];
}

/** Runs the feed until `stop()`; reconnects on its own. Returns `{ stop }`. */
export function startTrueDataFeed({ WebSocketImpl = globalThis.WebSocket } = {}) {
  let socket = null;
  let stopped = false;
  let lastMessage = 0;
  let retryMs = 2000;
  // True once TrueData accepted the login on the current connection.
  let ready = false;
  const ids = new Map();
  const subscribed = new Set();
  const pending = new Map();

  const send = (payload) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(payload));
  };

  function connect() {
    if (stopped) return;
    if (!isTrueDataConfigured()) {
      setTimeout(connect, 60_000).unref();
      return;
    }
    const port = Number(process.env.TRUEDATA_PORT) || 8082;
    const url = new URL(`wss://push.truedata.in:${port}`);
    url.searchParams.set('user', process.env.TRUEDATA_USER.trim());
    url.searchParams.set('password', process.env.TRUEDATA_PASSWORD.trim());
    ready = false;
    socket = new WebSocketImpl(url.toString());
    lastMessage = Date.now();
    socket.onopen = () => log.info('connected');
    socket.onmessage = (event) => {
      lastMessage = Date.now();
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.success === false) {
        log.warn('truedata refused', { message: String(message.message).slice(0, 200) });
        // Before the login is accepted it is the login or plan: wait a minute and try again. Later
        // refusals (e.g. one symbol) are only logged, so one bad symbol cannot stop everyone's feed.
        if (!ready) {
          retryMs = 60_000;
          reconnect();
        }
        return;
      }
      if (message?.message === 'TrueData Real Time Data Service') {
        ready = true;
        retryMs = 2000;
        subscribed.clear();
        syncSymbols().catch((error) => log.warn('sync failed', { error: errorName(error) }));
      }
      for (const tick of readFeedMessage(message, ids)) pending.set(tick.symbol, tick);
    };
    socket.onclose = () => reconnect();
    socket.onerror = () => reconnect();
  }

  /** Drops the current connection (without waiting for a closing handshake) and connects again. */
  function reconnect() {
    const old = socket;
    socket = null;
    ready = false;
    if (old) {
      old.onclose = old.onmessage = old.onerror = null;
      try {
        old.close();
      } catch {
        // already closed
      }
    }
    if (!stopped) setTimeout(connect, retryMs).unref();
    retryMs = Math.min(retryMs * 2, 60_000);
  }

  /** Subscribes to newly wanted symbols and drops ones nobody watches any more. */
  async function syncSymbols() {
    if (socket?.readyState !== 1) return;
    // The most recently wanted first, so the same symbols stay within the plan's limit.
    const rows = await LiveSubscription.find({ expiresAt: { $gt: new Date() } }, { _id: 1 })
      .sort({ expiresAt: -1 })
      .limit(MAX_SYMBOLS)
      .lean();
    const wanted = new Set(rows.map((row) => row._id));
    const add = [...wanted].filter((symbol) => !subscribed.has(symbol));
    const remove = [...subscribed].filter((symbol) => !wanted.has(symbol));
    if (add.length) send({ method: 'addsymbol', symbols: add.map(toTrueDataSymbol) });
    if (remove.length) send({ method: 'removesymbol', symbols: remove.map(toTrueDataSymbol) });
    for (const symbol of add) subscribed.add(symbol);
    for (const symbol of remove) subscribed.delete(symbol);
  }

  async function flush() {
    if (!pending.size) return;
    const ticks = [...pending.values()];
    pending.clear();
    await LiveQuote.bulkWrite(
      ticks.map((tick) => ({
        updateOne: {
          filter: { _id: tick.symbol },
          update: { $set: { price: tick.price, at: new Date(tick.at) } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  const timers = [
    setInterval(
      () => flush().catch((error) => log.warn('flush failed', { error: errorName(error) })),
      FLUSH_MS,
    ),
    setInterval(() => {
      syncSymbols().catch((error) => log.warn('sync failed', { error: errorName(error) }));
      // No message (not even a heartbeat) for a while: the connection is dead; reconnect now.
      if (socket && Date.now() - lastMessage > SILENCE_MS) reconnect();
      // Tells web processes the feed is alive (they fall back to brokers when it is not).
      if (ready) {
        LiveQuote.updateOne(
          { _id: FEED_HEARTBEAT_ID },
          { $set: { price: 0, at: new Date() } },
          { upsert: true },
        ).catch(() => undefined);
      }
    }, SYNC_MS),
  ];
  connect();
  return {
    stop() {
      stopped = true;
      timers.forEach(clearInterval);
      socket?.close();
    },
  };
}
