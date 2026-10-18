/**
 * Live prices from Kite's WebSocket (wss://ws.kite.trade) in LTP mode: one
 * connection per member, shared by all their open pages, opened when the first
 * page asks and closed when the last one leaves. Needs a Kite Connect app with
 * market data; without it Kite refuses the socket and pages keep polling.
 */
import { createLogger } from '../../logger.js';
import { activeConnection } from './connection.js';
import { instrumentToken, kiteProvider } from './market-data.js';

const log = createLogger('kite-ticker');
const TICKER_URL = 'wss://ws.kite.trade';
const MAX_RECONNECTS = 5;
const MAX_SYMBOLS = 50;
/** userId → { socket, tokens: Map<token, symbol>, listeners: Set, reconnects, closing } */
const feeds = new Map();

/**
 * Prices from one binary Kite message: [count:int16] then per packet
 * [length:int16][token:int32][last price in paise:int32]... (big-endian).
 * Single-byte heartbeats and text messages carry no prices.
 */
export function parseTicks(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4) return [];
  const ticks = [];
  let offset = 2;
  for (let index = 0; index < view.getInt16(0) && offset + 2 <= view.byteLength; index += 1) {
    const length = view.getInt16(offset);
    offset += 2;
    if (length >= 8 && offset + length <= view.byteLength) {
      // NSE equity prices arrive in paise.
      ticks.push({ token: view.getUint32(offset), price: view.getInt32(offset + 4) / 100 });
    }
    offset += length;
  }
  return ticks;
}

function send(feed, message) {
  if (feed.socket?.readyState === WebSocket.OPEN) feed.socket.send(JSON.stringify(message));
}

function subscribe(feed, tokens) {
  if (!tokens.length) return;
  send(feed, { a: 'subscribe', v: tokens });
  send(feed, { a: 'mode', v: ['ltp', tokens] });
}

function endFeed(userId, feed) {
  feed.closing = true;
  feeds.delete(userId);
  feed.socket?.close();
  for (const listener of feed.listeners) listener.onEnd();
  feed.listeners.clear();
}

async function connect(userId, feed) {
  const connection = await activeConnection(userId);
  if (!connection?.accessToken || feed.closing) return endFeed(userId, feed);
  const params = new URLSearchParams({
    api_key: process.env.KITE_API_KEY ?? '',
    access_token: connection.accessToken,
  });
  const socket = new WebSocket(`${TICKER_URL}?${params}`);
  socket.binaryType = 'arraybuffer';
  feed.socket = socket;
  socket.addEventListener('open', () => {
    feed.reconnects = 0;
    subscribe(feed, [...feed.tokens.keys()]);
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') return;
    for (const { token, price } of parseTicks(event.data)) {
      const symbol = feed.tokens.get(token);
      if (!symbol || !(price > 0)) continue;
      for (const listener of feed.listeners) {
        if (listener.symbols.has(symbol)) listener.onTick({ symbol, price });
      }
    }
  });
  socket.addEventListener('close', () => {
    if (feed.closing || feed.socket !== socket) return;
    if (!feed.listeners.size || feed.reconnects >= MAX_RECONNECTS) {
      log.warn('kite ticker closed', { reconnects: feed.reconnects });
      return endFeed(userId, feed);
    }
    feed.reconnects += 1;
    setTimeout(() => start(userId, feed), 2 ** feed.reconnects * 1000).unref();
  });
  socket.addEventListener('error', () => undefined);
}

function start(userId, feed) {
  connect(userId, feed).catch(() => endFeed(userId, feed));
}

/**
 * Streams live prices for up to 50 NSE symbols to `onTick({ symbol, price })`.
 * Resolves to an unsubscribe function, or null when Kite live data is not
 * available to this member (the caller keeps polling). `onEnd` is called if the
 * feed stops for good.
 */
export async function subscribeLiveQuotes(userId, symbols, { onTick, onEnd }) {
  if (!(await kiteProvider.isAvailable(userId))) return null;
  const wanted = [...new Set(symbols)].slice(0, MAX_SYMBOLS);
  const resolved = [];
  for (const symbol of wanted) {
    const token = await instrumentToken(symbol);
    if (token !== null) resolved.push([token, symbol]);
  }
  if (!resolved.length) return null;

  let feed = feeds.get(userId);
  const created = !feed;
  if (!feed) {
    feed = { socket: null, tokens: new Map(), listeners: new Set(), reconnects: 0, closing: false };
    feeds.set(userId, feed);
  }
  const added = resolved.filter(([token]) => !feed.tokens.has(token)).map(([token]) => token);
  for (const [token, symbol] of resolved) feed.tokens.set(token, symbol);
  const listener = { symbols: new Set(resolved.map(([, symbol]) => symbol)), onTick, onEnd };
  feed.listeners.add(listener);
  if (created) start(userId, feed);
  else subscribe(feed, added);

  return () => {
    feed.listeners.delete(listener);
    // shortcut: tokens stay subscribed until the last page leaves; fine for a few pages per member.
    if (!feed.listeners.size && feeds.get(userId) === feed) endFeed(userId, feed);
  };
}
