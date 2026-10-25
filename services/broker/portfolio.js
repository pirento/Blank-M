/**
 * The member's broker holdings, positions, orders and trades (in the shape
 * shared/broker-portfolio.js validates) and cash balance, read through the
 * broker's adapter (services/broker/adapters/). The checks every broker shares
 * live here.
 */
import {
  BROKER_PORTFOLIO_MAX_BYTES,
  BROKER_PORTFOLIO_MAX_ROWS,
  brokerHoldingSchema,
  brokerOrderSchema,
  brokerPortfolioSchema,
  brokerPositionSchema,
  brokerTradeSchema,
} from '../../shared/broker-portfolio.js';
import { MarketDataError } from '../market/types.js';
import { brokerFor } from './adapters/index.js';

const activeReads = new Set();

/** The IST calendar date (YYYY-MM-DD) for a millisecond timestamp. */
export function brokerTradingDate(now) {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * Provider GETs only. A failed section rejects the entire read, never an empty success.
 * `provider` defaults to the member's first connected broker with a portfolio (Zerodha first).
 */
export async function readBrokerPortfolio(userId, assertAccess, provider) {
  if (activeReads.has(userId)) {
    throw new MarketDataError('A portfolio read is already running. Wait and refresh again.', 429);
  }
  activeReads.add(userId);
  try {
    const adapter = await brokerFor(userId, 'portfolio', provider);
    const badPayload = () =>
      new MarketDataError(`${adapter.label} returned an invalid portfolio snapshot.`, 502);
    const checked = (schema) => (value) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw badPayload();
      return parsed.data;
    };
    const list = (value, schema, key) => {
      if (!Array.isArray(value) || value.length > BROKER_PORTFOLIO_MAX_ROWS) throw badPayload();
      const items = value.map(checked(schema));
      if (new Set(items.map(key)).size !== items.length) throw badPayload();
      return items;
    };
    const startedAt = new Date().toISOString();
    const tradingDate = brokerTradingDate(Date.parse(startedAt));
    const today = (value) => value === null || brokerTradingDate(Date.parse(value)) === tradingDate;
    const raw = await adapter.readPortfolio(userId, { tradingDate, assertAccess });
    if (!raw?.positions || typeof raw.positions !== 'object') throw badPayload();
    const instrumentKey = (item) => `${item.exchange}:${item.symbol}`;
    const positionKey = (item) => `${item.exchange}:${item.symbol}:${item.product}`;
    const holdings = list(raw.holdings, brokerHoldingSchema, instrumentKey);
    const net = list(raw.positions.net, brokerPositionSchema, positionKey);
    const day = list(raw.positions.day, brokerPositionSchema, positionKey);
    const orders = list(raw.orders, brokerOrderSchema, (item) => item.orderId).filter((order) => {
      if (
        BigInt(order.filledQuantity) +
          BigInt(order.pendingQuantity) +
          BigInt(order.cancelledQuantity) >
        BigInt(order.quantity)
      )
        throw badPayload();
      return today(order.placedAt);
    });
    const trades = list(
      raw.trades,
      brokerTradeSchema,
      (item) => `${item.exchange}:${item.orderId}:${item.tradeId}`,
    ).filter((trade) => today(trade.filledAt));
    await assertAccess();
    const fetchedAt = new Date().toISOString();
    if (brokerTradingDate(Date.parse(fetchedAt)) !== tradingDate) {
      throw new MarketDataError('The trading day changed during this read. Refresh again.', 409);
    }
    const snapshot = checked(brokerPortfolioSchema)({
      source: adapter.provider,
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

/**
 * The member's cash balance in rupees from `provider` (default: their first connected broker
 * with a balance, Zerodha first). Read-only; never falls back to another broker.
 */
export async function readBalance(userId, provider) {
  const adapter = await brokerFor(userId, 'balance', provider);
  const balance = await adapter.readBalance(userId);
  const amount = (value) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) * 100 <= Number.MAX_SAFE_INTEGER;
  if (
    !amount(balance?.available) ||
    (balance.used !== undefined && !amount(balance.used)) ||
    (balance.total !== undefined && !amount(balance.total))
  ) {
    throw new MarketDataError(`${adapter.label} did not return a valid live equity balance.`, 502);
  }
  return {
    liveBalance: balance.available,
    used: balance.used ?? null,
    total: balance.total ?? null,
    currency: 'INR',
    source: adapter.provider,
    label: adapter.label,
    fetchedAt: new Date().toISOString(),
  };
}
