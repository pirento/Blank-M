/**
 * Zerodha (Kite Connect) as a broker adapter (contract: ./index.js). Wraps the Kite code in
 * services/market/kite/, which keeps its own identity, session and outcome checks.
 */
import { z } from 'zod';
import { BROKER_PORTFOLIO_MAX_ROWS } from '../../../shared/broker-portfolio.js';
import {
  createVerifiedKiteReader,
  isKiteConfigured,
  placeKiteGtt,
  placeKiteLimitOrder,
  readBrokerBalance,
  readKiteOrder,
} from '../../market/kite.js';
import { MarketDataError } from '../../market/types.js';
import { toTick } from '../instruments.js';
import { brokerTradingDate } from '../portfolio.js';

/** The stop leg's limit price sits this far (percent) below its trigger, to help it fill. */
const STOP_LIMIT_BUFFER_PERCENT = 0.5;
const STATUSES = { COMPLETE: 'complete', REJECTED: 'rejected', CANCELLED: 'cancelled' };

const badPayload = () =>
  new MarketDataError('Zerodha returned an invalid portfolio snapshot.', 502);
const rowsSchema = z.array(z.record(z.unknown())).max(BROKER_PORTFOLIO_MAX_ROWS);

function envelope(payload) {
  const parsed = z.object({ status: z.literal('success'), data: z.unknown() }).safeParse(payload);
  if (!parsed.success) throw badPayload();
  return parsed.data.data;
}
function rows(payload) {
  const parsed = rowsSchema.safeParse(payload);
  if (!parsed.success) throw badPayload();
  return parsed.data;
}
function instrument(value) {
  return { symbol: value.tradingsymbol, exchange: value.exchange };
}

/** Kite's unzoned exchange timestamps are in IST; never infer the server's timezone. */
function exchangeTime(value, tradingDate) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    throw badPayload();
  }
  const date = new Date(`${value.replace(' ', 'T')}+05:30`);
  if (
    !Number.isFinite(date.getTime()) ||
    new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ') !==
      value ||
    brokerTradingDate(date.getTime()) !== tradingDate
  ) {
    throw badPayload();
  }
  return date.toISOString();
}

/**
 * True for a row stamped on another IST day. Between midnight and Kite clearing its books the
 * previous session's orders and trades are still listed; they are skipped, not treated as bad data.
 */
function fromOtherDay(value, tradingDate) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2} /.test(value) &&
    value.slice(0, 10) !== tradingDate
  );
}

/** Kite orders here are NSE only (as before adapters); anything else is refused, not rerouted. */
function nseOnly(exchange) {
  if (exchange !== 'NSE') throw new MarketDataError('Zerodha orders here are NSE only.', 400);
}

function position(item) {
  return {
    ...instrument(item),
    product: item.product,
    quantity: item.quantity,
    averagePrice: item.average_price,
    lastPrice: item.last_price,
  };
}

export default {
  label: 'Zerodha',
  capabilities: { portfolio: true, balance: true, orders: true, stopTarget: true },
  configured: isKiteConfigured,

  async readPortfolio(userId, { tradingDate, assertAccess }) {
    const reader = await createVerifiedKiteReader(userId, assertAccess);
    const holdings = rows(envelope(await reader.read('/portfolio/holdings'))).map((item) => ({
      ...instrument(item),
      isin: item.isin ?? null,
      quantity: item.quantity,
      t1Quantity: item.t1_quantity ?? null,
      usedQuantity: item.used_quantity ?? null,
      averagePrice: item.average_price,
      lastPrice: item.last_price,
    }));
    const positions = envelope(await reader.read('/portfolio/positions'));
    if (!positions || typeof positions !== 'object') throw badPayload();
    const net = rows(positions.net).map(position);
    const day = rows(positions.day).map(position);
    const orders = rows(envelope(await reader.read('/orders')))
      .filter((item) => !fromOtherDay(item.order_timestamp, tradingDate))
      .map((item) => ({
        ...instrument(item),
        orderId: item.order_id,
        product: item.product,
        side: item.transaction_type,
        status: item.status,
        orderType: item.order_type,
        quantity: item.quantity,
        filledQuantity: item.filled_quantity,
        pendingQuantity: item.pending_quantity,
        cancelledQuantity: item.cancelled_quantity,
        price: item.price,
        averagePrice: item.average_price,
        placedAt: exchangeTime(item.order_timestamp, tradingDate),
      }));
    const trades = rows(envelope(await reader.read('/trades')))
      .filter((item) => !fromOtherDay(item.exchange_timestamp, tradingDate))
      .map((item) => ({
        ...instrument(item),
        tradeId: item.trade_id,
        orderId: item.order_id,
        product: item.product,
        side: item.transaction_type,
        quantity: item.quantity,
        averagePrice: item.average_price,
        filledAt: exchangeTime(item.exchange_timestamp, tradingDate),
      }));
    await reader.assertUnchanged();
    return { holdings, positions: { net, day }, orders, trades };
  },

  async readBalance(userId) {
    return { available: (await readBrokerBalance(userId)).liveBalance };
  },

  async placeLimitOrder(userId, { symbol, exchange, side, product, quantity, price, tag }) {
    nseOnly(exchange);
    return placeKiteLimitOrder(userId, {
      symbol,
      side,
      product,
      quantity,
      price: String(price),
      tag,
    });
  },

  async readOrder(userId, orderId) {
    const order = await readKiteOrder(userId, orderId);
    return {
      status: STATUSES[order.status] ?? 'open',
      filledQuantity: order.filledQuantity,
      averagePrice: order.averagePrice,
      message: null,
    };
  },

  /** A Kite GTT: two legs (one cancels the other) or a single stop leg. */
  async placeStopTarget(userId, { symbol, exchange, quantity, stopLoss, target, lastPrice }) {
    nseOnly(exchange);
    return placeKiteGtt(userId, {
      symbol,
      side: 'SELL',
      product: 'CNC',
      quantity,
      lastPrice,
      legs: [
        // Triggers are sent on the tick too; the stop rounds down, the target up.
        {
          trigger: toTick(stopLoss, false),
          price: toTick(stopLoss * (1 - STOP_LIMIT_BUFFER_PERCENT / 100), false),
        },
        ...(target !== null
          ? [{ trigger: toTick(target, true), price: toTick(target, true) }]
          : []),
      ],
    });
  },
};
