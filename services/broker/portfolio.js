/**
 * Reads the member's Zerodha holdings, positions, orders and trades into the
 * shape shared/broker-portfolio.js validates.
 */
import { z } from 'zod';
import {
  BROKER_PORTFOLIO_MAX_BYTES,
  BROKER_PORTFOLIO_MAX_ROWS,
  brokerHoldingSchema,
  brokerOrderSchema,
  brokerPortfolioSchema,
  brokerPositionSchema,
  brokerTradeSchema,
} from '../../shared/broker-portfolio.js';
import { createVerifiedKiteReader } from '../market/kite.js';
import { MarketDataError } from '../market/types.js';

const activeReads = new Set();
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
function checked(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badPayload();
  return parsed.data;
}
function unique(values, key) {
  if (new Set(values.map(key)).size !== values.length) throw badPayload();
  return values;
}
function instrument(value) {
  return { symbol: value.tradingsymbol, exchange: value.exchange };
}
/** The IST calendar date (YYYY-MM-DD) for a millisecond timestamp. */
export function brokerTradingDate(now) {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
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

/** Provider GETs only. A failed section rejects the entire read, never an empty success. */
export async function readBrokerPortfolio(userId, assertAccess) {
  if (activeReads.has(userId)) {
    throw new MarketDataError('A portfolio read is already running. Wait and refresh again.', 429);
  }
  activeReads.add(userId);
  try {
    const startedAt = new Date().toISOString();
    const tradingDate = brokerTradingDate(Date.parse(startedAt));
    const reader = await createVerifiedKiteReader(userId, assertAccess);
    const holdings = unique(
      rows(envelope(await reader.read('/portfolio/holdings'))).map((item) =>
        checked(brokerHoldingSchema, {
          ...instrument(item),
          isin: item.isin ?? null,
          quantity: item.quantity,
          t1Quantity: item.t1_quantity ?? null,
          usedQuantity: item.used_quantity ?? null,
          averagePrice: item.average_price,
          lastPrice: item.last_price,
        }),
      ),
      (item) => `${item.exchange}:${item.symbol}`,
    );
    const positionPayload = envelope(await reader.read('/portfolio/positions'));
    if (!positionPayload || typeof positionPayload !== 'object') throw badPayload();
    const positions = positionPayload;
    const parsePositions = (input) =>
      unique(
        rows(input).map((item) =>
          checked(brokerPositionSchema, {
            ...instrument(item),
            product: item.product,
            quantity: item.quantity,
            averagePrice: item.average_price,
            lastPrice: item.last_price,
          }),
        ),
        (item) => `${item.exchange}:${item.symbol}:${item.product}`,
      );
    const net = parsePositions(positions.net);
    const day = parsePositions(positions.day);
    const orders = unique(
      rows(envelope(await reader.read('/orders'))).map((item) => {
        const order = checked(brokerOrderSchema, {
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
        });
        if (
          BigInt(order.filledQuantity) +
            BigInt(order.pendingQuantity) +
            BigInt(order.cancelledQuantity) >
          BigInt(order.quantity)
        )
          throw badPayload();
        return order;
      }),
      (item) => item.orderId,
    );
    const trades = unique(
      rows(envelope(await reader.read('/trades'))).map((item) =>
        checked(brokerTradeSchema, {
          ...instrument(item),
          tradeId: item.trade_id,
          orderId: item.order_id,
          product: item.product,
          side: item.transaction_type,
          quantity: item.quantity,
          averagePrice: item.average_price,
          filledAt: exchangeTime(item.exchange_timestamp, tradingDate),
        }),
      ),
      (item) => `${item.exchange}:${item.orderId}:${item.tradeId}`,
    );
    await reader.assertUnchanged();
    const fetchedAt = new Date().toISOString();
    if (brokerTradingDate(Date.parse(fetchedAt)) !== tradingDate) {
      throw new MarketDataError('The trading day changed during this read. Refresh again.', 409);
    }
    const snapshot = checked(brokerPortfolioSchema, {
      source: 'kite',
      currency: 'INR',
      startedAt,
      fetchedAt,
      tradingDate,
      holdings,
      positions: { net, day },
      orders,
      trades,
    });
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > BROKER_PORTFOLIO_MAX_BYTES) {
      throw new MarketDataError('The portfolio snapshot exceeds the supported response size.', 502);
    }
    return snapshot;
  } finally {
    activeReads.delete(userId);
  }
}
