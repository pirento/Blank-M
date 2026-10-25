/**
 * Upstox as a broker adapter (contract: ./index.js): the portfolio, the equity balance, NSE
 * equity DAY LIMIT orders (Place Order V3) and their status. No stop-loss and target: an Upstox
 * GTT must start with an ENTRY leg and its TARGET/STOPLOSS legs only exit that entry, so it
 * cannot hold a one-cancels-the-other exit for shares already held.
 */
import { BrokerConnection } from '../../../models/index.js';
import { HttpError } from '../../errors.js';
import { brokerMessage, withBrokerToken } from '../broker-api.js';
import { equitySymbol, istToIso } from '../fill-mapping.js';
import { brokerInstrument } from '../instruments.js';
import { upstoxConfigured, upstoxGet, upstoxList, upstoxPost, upstoxProduct } from '../upstox.js';

const LABEL = 'Upstox';
const ORDER_URL = 'https://api-hft.upstox.com/v3/order/place';
const MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
const MASTER_TIMEOUT_MS = 60_000;
const MAX_ROW_CHARS = 64 * 1024;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
/** Upstox's final order statuses (appendix/order-status); every other one is still working. */
const FINAL = new Map([
  ['complete', 'complete'],
  ['rejected', 'rejected'],
  ['cancelled', 'cancelled'],
  ['cancelled after market order', 'cancelled'],
]);

const badPayload = () => new HttpError('Upstox returned an invalid portfolio snapshot.', 502);
/** Rupees; 0 when Upstox gives none (it sends null or "" for an empty price). */
const amount = (value) => (value === null || value === undefined || value === '' ? 0 : value);

/** ISO UTC time of an Upstox IST timestamp ("2023-10-19 13:25:13", "03-Aug-2017 15:03:42"). */
function istTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const iso = istToIso(value);
  if (!iso) throw badPayload();
  return iso;
}

function instrument(row) {
  return { symbol: equitySymbol(row.trading_symbol), exchange: row.exchange };
}

function position(row, quantity, averagePrice) {
  return {
    ...instrument(row),
    product: upstoxProduct(row.product, row.exchange),
    quantity,
    averagePrice: amount(averagePrice),
    lastPrice: amount(row.last_price),
  };
}

/** The error for an order that may have reached Upstox: it must never be sent again blindly. */
function unknownOutcome() {
  return new HttpError(
    'The order outcome is unknown. Check your Upstox order book before trying again.',
    504,
    { outcome: 'unknown' },
  );
}

/**
 * Runs `run(token)` once Upstox confirms the token belongs to the account linked to this member
 * (profile user_id = the user_id stored at login).
 */
async function verified(userId, run) {
  if (!upstoxConfigured())
    throw new HttpError('The administrator has not set Upstox app keys yet.', 503);
  return withBrokerToken(userId, 'upstox', LABEL, async (token) => {
    const profile = await upstoxGet(token, '/user/profile', 'profile');
    const linked = await BrokerConnection.findOne(
      { userId, provider: 'upstox' },
      { brokerUserId: 1 },
    ).lean();
    if (!linked?.brokerUserId || profile?.user_id !== linked.brokerUserId) {
      throw new HttpError(
        'The linked Upstox account could not be verified. Reconnect Upstox in Settings.',
        409,
      );
    }
    return run(token);
  });
}

/**
 * NSE equity rows of Upstox's instrument master: a gzipped JSON array of about 40 MB, read as a
 * stream one object at a time so the file is never held whole.
 */
async function* nseEquities() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MASTER_TIMEOUT_MS);
  try {
    const response = await fetch(MASTER_URL, { redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const stream = response.body
      .pipeThrough(new DecompressionStream('gzip'))
      .pipeThrough(new TextDecoderStream());
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let partial = '';
    for await (const text of stream) {
      let start = depth ? 0 : -1;
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') {
          if (depth++ === 0) start = index;
        } else if (char === '}' && --depth === 0) {
          const row = JSON.parse(partial + text.slice(start, index + 1));
          partial = '';
          // Upstox's own filter for cash equities: segment NSE_EQ, instrument_type EQ.
          if (row.segment === 'NSE_EQ' && row.instrument_type === 'EQ') {
            yield {
              exchange: 'NSE',
              symbol: row.trading_symbol,
              token: row.instrument_key,
              isin: row.isin,
              lotSize: row.lot_size,
            };
          }
        }
      }
      if (depth) {
        partial += text.slice(start);
        if (partial.length > MAX_ROW_CHARS) throw new Error('row too long');
      }
    }
  } catch {
    throw new HttpError('The Upstox instrument list could not be loaded. Try again shortly.', 503);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export default {
  label: LABEL,
  capabilities: { portfolio: true, balance: true, orders: true, stopTarget: false },
  configured: upstoxConfigured,

  readPortfolio(userId, { assertAccess }) {
    return verified(userId, async (token) => {
      await assertAccess();
      const [holdings, positions, orders, trades] = await Promise.all([
        upstoxList(token, '/portfolio/long-term-holdings', 'holding list'),
        upstoxList(token, '/portfolio/short-term-positions', 'position list'),
        upstoxList(token, '/order/retrieve-all', 'order book'),
        upstoxList(token, '/order/trades/get-trades-for-day', 'trade book'),
      ]);
      return {
        holdings: holdings.map((row) => ({
          ...instrument(row),
          isin: row.isin ?? null,
          quantity: row.quantity,
          t1Quantity: row.t1_quantity ?? null,
          usedQuantity: row.cnc_used_quantity ?? null,
          averagePrice: amount(row.average_price),
          lastPrice: amount(row.last_price),
        })),
        positions: {
          net: positions.map((row) => position(row, row.quantity, row.average_price)),
          // Today's part of each position, so net − day is what was carried in.
          day: positions
            .filter((row) => row.day_buy_quantity || row.day_sell_quantity)
            .map((row) => {
              const quantity = row.day_buy_quantity - row.day_sell_quantity;
              return position(row, quantity, quantity < 0 ? row.day_sell_price : row.day_buy_price);
            }),
        },
        orders: orders.map((row) => {
          const final = FINAL.get(String(row.status).toLowerCase());
          return {
            ...instrument(row),
            orderId: row.order_id,
            product: upstoxProduct(row.product, row.exchange),
            side: row.transaction_type,
            status: row.status,
            orderType: row.order_type,
            quantity: row.quantity,
            filledQuantity: row.filled_quantity,
            // Upstox leaves the unfilled rest as pending on a cancelled order.
            pendingQuantity: final ? 0 : row.pending_quantity,
            cancelledQuantity: final === 'cancelled' ? row.quantity - row.filled_quantity : 0,
            price: amount(row.price),
            averagePrice: amount(row.average_price),
            placedAt: istTime(row.order_timestamp),
          };
        }),
        trades: trades.map((row) => ({
          ...instrument(row),
          tradeId: row.trade_id,
          orderId: row.order_id,
          product: upstoxProduct(row.product, row.exchange),
          side: row.transaction_type,
          quantity: row.quantity,
          averagePrice: amount(row.average_price),
          filledAt: istTime(row.exchange_timestamp),
        })),
      };
    });
  },

  readBalance(userId) {
    return verified(userId, async (token) => {
      // Since July 2025 `equity` holds the equity and commodity funds together.
      const funds = await upstoxGet(token, '/user/get-funds-and-margin', 'balance');
      return {
        available: funds?.equity?.available_margin,
        used: funds?.equity?.used_margin ?? undefined,
      };
    });
  },

  async placeLimitOrder(userId, { symbol, exchange, side, product, quantity, price, tag }) {
    const code = product === 'CNC' ? 'D' : product === 'MIS' ? 'I' : null;
    if (exchange !== 'NSE' || !code || (side !== 'BUY' && side !== 'SELL')) {
      throw new HttpError('Upstox orders here are NSE equity delivery (CNC) or MIS only.', 400);
    }
    const listed = await brokerInstrument('upstox', 'NSE', symbol, nseEquities);
    if (!listed) throw new HttpError(`Upstox does not list ${symbol} as an NSE equity.`, 400);
    return verified(userId, async (token) => {
      let payload;
      try {
        payload = await upstoxPost(token, ORDER_URL, {
          quantity,
          product: code,
          validity: 'DAY',
          price,
          tag,
          instrument_token: listed.token,
          order_type: 'LIMIT',
          transaction_type: side,
          disclosed_quantity: 0,
          trigger_price: 0,
          is_amo: false,
          // One order, never split by the freeze quantity.
          slice: false,
        });
      } catch (error) {
        // The profile read just accepted this token, so a 401/403 is about the order, not the
        // token: refused, and the connection stays linked.
        if (error.tokenRejected) {
          throw new HttpError(
            "Upstox refused the order. Check that this server's static IP is registered in your Upstox account and the app may place orders.",
            403,
          );
        }
        // Also refused for sure: the rate limit, or a 4xx with Upstox's reason.
        if (error.status === 429) throw error;
        if (error.httpStatus >= 400 && error.httpStatus < 500) {
          const reason = brokerMessage(error.body);
          throw new HttpError(
            reason
              ? `Upstox rejected the order: ${reason}`
              : `Upstox rejected the order (${error.httpStatus}).`,
            502,
          );
        }
        // A timeout, a 5xx or an unreadable reply: the order may still have been placed.
        throw unknownOutcome();
      }
      const ids = payload?.data?.order_ids;
      if (
        payload?.status !== 'success' ||
        !Array.isArray(ids) ||
        ids.length !== 1 ||
        typeof ids[0] !== 'string' ||
        !ID.test(ids[0])
      ) {
        throw unknownOutcome();
      }
      return { orderId: ids[0] };
    });
  },

  async readOrder(userId, orderId) {
    if (typeof orderId !== 'string' || !ID.test(orderId))
      throw new HttpError('Invalid order ID.', 400);
    return verified(userId, async (token) => {
      const order = await upstoxGet(token, `/order/details?order_id=${orderId}`, 'order');
      const filled = order?.filled_quantity;
      const averagePrice = amount(order?.average_price);
      if (
        typeof order?.status !== 'string' ||
        !Number.isSafeInteger(order.quantity) ||
        !Number.isSafeInteger(filled) ||
        filled < 0 ||
        !Number.isFinite(averagePrice) ||
        averagePrice < 0
      ) {
        throw new HttpError('The order could not be read from Upstox.', 502);
      }
      let status = FINAL.get(order.status.toLowerCase()) ?? 'open';
      if (status === 'complete' && filled !== order.quantity) status = 'open';
      return {
        status,
        filledQuantity: filled,
        averagePrice,
        message:
          status === 'rejected' || status === 'cancelled'
            ? brokerMessage({ message: order.status_message })
            : null,
      };
    });
  },
};
