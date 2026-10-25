/**
 * Fyers (API v3) as a broker adapter (contract: ./index.js), over the OAuth connection in
 * ../fyers.js. Every call first checks with Fyers' profile that the stored token still belongs to
 * the linked client ID. Fields follow https://fyers.in/api-docs/v3/api/ (orders/sync,
 * gtt/orders/sync, orders, tradebook, positions, holdings, funds, profile).
 */
import { BrokerConnection } from '../../../models/index.js';
import { MarketDataError } from '../../market/types.js';
import { brokerMessage, withBrokerToken } from '../broker-api.js';
import { istToIso } from '../fill-mapping.js';
import {
  fyersConfigured,
  fyersInstrument,
  fyersList,
  fyersProduct,
  fyersRequest,
} from '../fyers.js';
import { toTick } from '../instruments.js';

const LABEL = 'Fyers';
/** The stop leg's limit price sits this far (percent) below its trigger, to help it fill. */
const STOP_LIMIT_BUFFER_PERCENT = 0.5;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
/** An NSE cash symbol as plans hold it ("SBIN", "M&M"); Fyers names it "NSE:SBIN-EQ". */
const EQUITY = /^[A-Z0-9][A-Z0-9&-]{0,39}$/;
const SIDES = { BUY: 1, SELL: -1 };
const SIDE_NAMES = { 1: 'BUY', [-1]: 'SELL' };
const PRODUCTS = { CNC: 'CNC', MIS: 'INTRADAY' };
/** Order status codes (Get Orders); 3 is unused. */
const STATUS_NAMES = {
  1: 'CANCELLED',
  2: 'TRADED',
  4: 'TRANSIT',
  5: 'REJECTED',
  6: 'PENDING',
  7: 'EXPIRED',
};
const FINAL = { 1: 'cancelled', 5: 'rejected', 7: 'cancelled' };
const ORDER_TYPES = { 1: 'LIMIT', 2: 'MARKET', 3: 'SL-M', 4: 'SL' };
/** Error codes for a rate limit (-360 is the Standard plan's). */
const RATE_CODES = new Set([-429, -360]);

const badPayload = () => new MarketDataError('Fyers returned an invalid portfolio snapshot.', 502);

/** Fyers' IST "DD-MMM-YYYY hh:mm:ss" as ISO UTC; an unreadable time rejects the read. */
function istTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const iso = istToIso(value);
  if (!iso) throw badPayload();
  return iso;
}

function instrumentOf(row) {
  const { exchange, symbol, rawSymbol } = fyersInstrument(row);
  // An F&O name ../fyers.js cannot rewrite Kite-style is shown as Fyers spells it.
  return { exchange, symbol: symbol ?? rawSymbol.split(':').pop() };
}

/** The side's own average: Fyers' netAvg also nets booked profit and can go below zero. */
const averageFor = (quantity, row) => (quantity > 0 ? row.buyAvg : quantity < 0 ? row.sellAvg : 0);

function position(row, quantity, averagePrice) {
  return {
    ...instrumentOf(row),
    product: fyersProduct(row.productType),
    quantity,
    averagePrice,
    lastPrice: row.ltp,
  };
}

function holding(row) {
  // remainingQuantity is the day's opening quantity less what was sold today.
  const used = row.quantity - row.remainingQuantity;
  return {
    ...instrumentOf(row),
    isin: row.isin || null,
    quantity: row.quantity,
    t1Quantity: row.qty_t1 ?? null,
    usedQuantity: Number.isSafeInteger(used) && used >= 0 ? used : null,
    averagePrice: row.costPrice,
    lastPrice: row.ltp,
  };
}

function order(row) {
  const open = row.status === 4 || row.status === 6;
  return {
    ...instrumentOf(row),
    orderId: row.id,
    product: fyersProduct(row.productType),
    side: SIDE_NAMES[row.side] ?? null,
    status: STATUS_NAMES[row.status] ?? null,
    orderType: ORDER_TYPES[row.type] ?? null,
    quantity: row.qty,
    filledQuantity: row.filledQty,
    pendingQuantity: open ? row.remainingQuantity : 0,
    cancelledQuantity: FINAL[row.status] === 'cancelled' ? row.qty - row.filledQty : 0,
    price: row.limitPrice,
    averagePrice: row.tradedPrice,
    placedAt: istTime(row.orderDateTime),
  };
}

function trade(row) {
  return {
    ...instrumentOf(row),
    tradeId: row.tradeNumber,
    orderId: row.orderNumber,
    product: fyersProduct(row.productType),
    side: SIDE_NAMES[row.side] ?? null,
    quantity: row.tradedQty,
    averagePrice: row.tradePrice,
    filledAt: istTime(row.orderDateTime),
  };
}

/** Orders here are NSE equity only (as for Zerodha); anything else is refused, not rerouted. */
function nseEquity(symbol, exchange, quantity) {
  if (
    exchange !== 'NSE' ||
    !EQUITY.test(String(symbol)) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1
  ) {
    throw new MarketDataError('Fyers orders here need an NSE equity symbol and quantity.', 400);
  }
}

/**
 * Runs `call(token, clientId)` with the member's token once Fyers' profile confirms it belongs to
 * the linked client ID (saved from the token's fy_id when the member connected).
 */
async function verified(userId, call) {
  if (!fyersConfigured()) throw new MarketDataError('Fyers is not configured on this server.', 503);
  return withBrokerToken(userId, 'fyers', LABEL, async (token) => {
    const linked = (
      await BrokerConnection.findOne({ userId, provider: 'fyers' }, { brokerUserId: 1 }).lean()
    )?.brokerUserId;
    const profile = await fyersRequest(token, '/profile');
    if (!linked || profile?.s !== 'ok' || profile.data?.fy_id !== linked) {
      throw new MarketDataError(
        'The linked Fyers account could not be verified. Reconnect Fyers in Settings.',
        409,
      );
    }
    return call(token, linked);
  });
}

/**
 * The error for a request whose result we cannot know: it may still have reached Fyers, so it
 * must not be treated as rejected (that would let the same real order be sent again).
 */
function unknownOutcome(what) {
  const error = new MarketDataError(
    `The ${what} outcome is unknown. Check your Fyers ${what === 'order' ? 'order book' : 'GTT orders'} before trying again.`,
    504,
  );
  error.outcome = 'unknown';
  return error;
}

/**
 * POSTs an order or GTT and returns its Fyers ID. Anything that may have reached Fyers without a
 * confirmed ID (timeout, 5xx, unreadable reply, code 201 "not acknowledged", no ID) is outcome
 * 'unknown'; a refusal (s: "error") keeps Fyers' reason.
 */
async function place(token, path, body, what) {
  let payload;
  try {
    payload = await fyersRequest(token, path, body);
  } catch (error) {
    if (error.tokenRejected || error.status === 429) throw error;
    // Only a 4xx carrying Fyers' JSON reason is a sure refusal.
    if (!error.body || !(error.httpStatus < 500)) throw unknownOutcome(what);
    payload = error.body;
  }
  if (payload?.s === 'ok') {
    if (payload.code !== 201 && typeof payload.id === 'string' && ID.test(payload.id)) {
      return payload.id;
    }
    throw unknownOutcome(what);
  }
  if (payload?.s !== 'error') throw unknownOutcome(what);
  const reason = brokerMessage(payload);
  throw new MarketDataError(
    reason ? `Fyers rejected the ${what}: ${reason}` : `Fyers rejected the ${what}.`,
    RATE_CODES.has(Number(payload.code)) ? 429 : 502,
  );
}

export default {
  label: LABEL,
  capabilities: { portfolio: true, balance: true, orders: true, stopTarget: true },
  configured: fyersConfigured,

  async readPortfolio(userId, { assertAccess }) {
    await assertAccess();
    return verified(userId, async (token) => {
      const read = async (path, field, what) => {
        await assertAccess();
        return fyersList(token, path, field, what);
      };
      const holdings = (await read('/holdings', 'holdings', 'holding list')).map(holding);
      const positions = await read('/positions', 'netPositions', 'position list');
      const orders = (await read('/orders', 'orderBook', 'order book')).map(order);
      const trades = (await read('/tradebook', 'tradeBook', 'trade book')).map(trade);
      // Fyers has no day list: a position's day part is its day buy and sell quantities.
      const day = positions
        .filter((row) => row.dayBuyQty || row.daySellQty)
        .map((row) => {
          const quantity = row.dayBuyQty - row.daySellQty;
          // With carried quantity the row's averages are not today's alone, so none is given.
          const average = row.cfBuyQty || row.cfSellQty ? 0 : averageFor(quantity, row);
          return position(row, quantity, average);
        });
      return {
        holdings,
        positions: {
          net: positions.map((row) => position(row, row.netQty, averageFor(row.netQty, row))),
          day,
        },
        orders,
        trades,
      };
    });
  },

  async readBalance(userId) {
    return verified(userId, async (token) => {
      const rows = await fyersList(token, '/funds', 'fund_limit', 'fund balance');
      // Rows are found by title, as Fyers advises, never by position.
      const equity = (title) => rows.find((row) => row.title === title)?.equityAmount;
      return {
        available: equity('Available Balance'),
        used: equity('Utilized Amount'),
        total: equity('Total Balance'),
      };
    });
  },

  async placeLimitOrder(userId, { symbol, exchange, side, product, quantity, price, tag }) {
    nseEquity(symbol, exchange, quantity);
    if (!SIDES[side] || !PRODUCTS[product] || !(Number.isFinite(price) && price > 0)) {
      throw new MarketDataError('Fyers orders here are CNC or MIS limit orders only.', 400);
    }
    return verified(userId, async (token, clientId) => {
      // orderTag: 1 to 30 letters or digits, and never the client ID or "Untagged".
      const orderTag = String(tag ?? '')
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 30);
      const tagged =
        Boolean(orderTag) && !['UNTAGGED', clientId.toUpperCase()].includes(orderTag.toUpperCase());
      const orderId = await place(
        token,
        '/orders/sync',
        {
          symbol: `NSE:${symbol}-EQ`,
          qty: quantity,
          type: 1,
          side: SIDES[side],
          productType: PRODUCTS[product],
          limitPrice: price,
          stopPrice: 0,
          validity: 'DAY',
          disclosedQty: 0,
          offlineOrder: false,
          isSliceOrder: false,
          ...(tagged && { orderTag }),
        },
        'order',
      );
      return { orderId };
    });
  },

  async readOrder(userId, orderId) {
    if (!ID.test(String(orderId))) throw new MarketDataError('Invalid order ID.', 400);
    return verified(userId, async (token) => {
      const rows = await fyersList(token, `/orders?id=${orderId}`, 'orderBook', 'order');
      const row = rows.find((item) => item.id === orderId);
      if (
        !row ||
        !Number.isSafeInteger(row.qty) ||
        !Number.isSafeInteger(row.filledQty) ||
        !(row.tradedPrice >= 0)
      ) {
        throw new MarketDataError('The order could not be read from Fyers.', 502);
      }
      const final = FINAL[row.status];
      const reason = typeof row.message === 'string' ? row.message.trim().slice(0, 300) : '';
      return {
        status: row.status === 2 && row.filledQty === row.qty ? 'complete' : (final ?? 'open'),
        filledQuantity: row.filledQty,
        averagePrice: row.tradedPrice,
        message: final && reason ? reason : null,
      };
    });
  },

  /** A GTT for the holding: OCO (leg1 the target above the price, leg2 the stop below) or a lone stop. */
  async placeStopTarget(userId, { symbol, exchange, quantity, stopLoss, target }) {
    nseEquity(symbol, exchange, quantity);
    // Triggers are sent on the tick; the stop rounds down, the target up.
    const stop = {
      price: toTick(stopLoss * (1 - STOP_LIMIT_BUFFER_PERCENT / 100), false),
      triggerPrice: toTick(stopLoss, false),
      qty: quantity,
    };
    const orderInfo =
      target === null
        ? { leg1: stop }
        : {
            leg1: {
              price: toTick(target, true),
              triggerPrice: toTick(target, true),
              qty: quantity,
            },
            leg2: stop,
          };
    return verified(userId, async (token) => ({
      triggerId: await place(
        token,
        '/gtt/orders/sync',
        { side: -1, symbol: `NSE:${symbol}-EQ`, productType: 'CNC', orderInfo },
        'GTT',
      ),
    }));
  },
};
