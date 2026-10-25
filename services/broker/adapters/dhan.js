/**
 * Dhan (DhanHQ API v2) as a broker adapter (contract: ./index.js), with the member's personal
 * access token from ../dhan.js. Endpoints and fields follow https://dhanhq.co/docs/v2/.
 *
 * No stop-loss/target: Dhan takes a sell Forever order only once the delivery shares reach the
 * demat (the next day), while the shared flow places it on the fill day and then confirms the
 * fill from Dhan's order book, which lists only today's orders. Its OCO docs also disagree on
 * which leg is the target.
 */
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { BrokerConnection } from '../../../models/index.js';
import { MarketDataError } from '../../market/types.js';
import { brokerRows, withBrokerToken } from '../broker-api.js';
import { EXCHANGES, dhanGet, dhanHoldings, dhanPost, istToIso, journalSymbol } from '../dhan.js';
import { brokerInstrument } from '../instruments.js';

const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const SCRIP_MASTER_TIMEOUT_MS = 120_000;
/** NSE series of shares and ETFs: debt and warrants reuse some share symbols (MOTHERSON). */
const SHARE_SERIES = new Set(['EQ', 'BE', 'BZ', 'SM', 'ST']);
const ORDER_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** Final Dhan order statuses; every other one (TRANSIT, PENDING, PART_TRADED…) is still open. */
const STATUSES = {
  TRADED: 'complete',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  EXPIRED: 'cancelled',
};
const ORDER_PRODUCTS = { CNC: 'CNC', MIS: 'INTRADAY' };
const product = (value) => (value === 'INTRADAY' ? 'MIS' : value);

/** NSE share and ETF security IDs, streamed from Dhan's scrip master (all segments, ~27 MB). */
async function nseShares() {
  const response = await fetch(SCRIP_MASTER_URL, {
    signal: AbortSignal.timeout(SCRIP_MASTER_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new MarketDataError('The Dhan instrument list could not be read.', 502);
  }
  const lines = createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity });
  const bySymbol = new Map();
  let header = null;
  for await (const line of lines) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (!header) {
      header = cells;
      continue;
    }
    const cell = (name) => cells[header.indexOf(name)];
    if (
      cells.length !== header.length ||
      cell('SEM_EXM_EXCH_ID') !== 'NSE' ||
      cell('SEM_SEGMENT') !== 'E' ||
      !SHARE_SERIES.has(cell('SEM_SERIES'))
    ) {
      continue;
    }
    const symbol = (cell('SEM_TRADING_SYMBOL') ?? '').toUpperCase();
    // A symbol listed twice is ambiguous: leave it out rather than risk the wrong security.
    bySymbol.set(
      symbol,
      bySymbol.has(symbol)
        ? null
        : { exchange: 'NSE', symbol, token: cell('SEM_SMST_SECURITY_ID') },
    );
  }
  return [...bySymbol.values()].filter(Boolean);
}

async function nseSecurityId(symbol) {
  const row = await brokerInstrument('dhan', 'NSE', symbol, nseShares);
  if (!row) throw new MarketDataError(`Dhan does not list ${symbol} as an NSE share.`, 400);
  return row.token;
}

/** Runs `call(token, clientId)` once Dhan's profile confirms the token is the linked client's. */
function verified(userId, call) {
  return withBrokerToken(userId, 'dhan', 'Dhan', async (token) => {
    const row = await BrokerConnection.findOne(
      { userId, provider: 'dhan' },
      { brokerUserId: 1 },
    ).lean();
    const profile = await dhanGet('/profile', token);
    if (!row?.brokerUserId || String(profile?.dhanClientId ?? '') !== row.brokerUserId) {
      throw new MarketDataError('The linked Dhan account could not be verified.', 409);
    }
    return call(token, row.brokerUserId);
  });
}

/** The order may have reached Dhan: it must not count as rejected (the plan could go twice). */
function unknownOutcome() {
  const error = new MarketDataError(
    'The order outcome is unknown. Check your Dhan order book before trying again.',
    504,
  );
  error.outcome = 'unknown';
  return error;
}

/** Places one order and returns its ID. Only a readable refusal means Dhan did not take it. */
async function postOrder(token, body) {
  let reply;
  try {
    reply = await dhanPost('/orders', token, body);
  } catch (error) {
    // The profile read just accepted this token, so a 401/403 is about the order, not the token.
    if (error.tokenRejected) {
      throw new MarketDataError(
        'Dhan refused the order. Dhan takes API orders only from a static IP whitelisted in your Dhan account.',
        403,
      );
    }
    if (error.status === 429) throw error;
    if (error.httpStatus >= 400 && error.httpStatus < 500) {
      const reason = [error.body?.errorCode, error.body?.errorMessage]
        .filter((value) => typeof value === 'string' && value.trim())
        .join(' ')
        .slice(0, 300);
      throw new MarketDataError(
        reason ? `Dhan rejected the order: ${reason}` : 'Dhan rejected the order.',
        502,
      );
    }
    throw unknownOutcome();
  }
  if (reply?.orderStatus === 'REJECTED') throw new MarketDataError('Dhan rejected the order.', 502);
  const orderId = Number.isSafeInteger(reply?.orderId) ? String(reply.orderId) : reply?.orderId;
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) throw unknownOutcome();
  return orderId;
}

/** Dhan's order book example leaves tradingSymbol empty; the security ID still names the row. */
const symbolOf = (item, exchange) =>
  journalSymbol(item, exchange) ||
  String(item.tradingSymbol ?? '').trim() ||
  String(item.securityId ?? '');

function instrument(item) {
  const exchange = EXCHANGES[item.exchangeSegment] ?? String(item.exchangeSegment ?? '');
  return { symbol: symbolOf(item, exchange), exchange };
}

/** A net or day position; Dhan's positions carry no last price. */
function position(item, quantity, buyPrice, sellPrice) {
  return {
    ...instrument(item),
    product: product(item.productType),
    quantity,
    averagePrice: quantity > 0 ? buyPrice : quantity < 0 ? sellPrice : 0,
    lastPrice: 0,
  };
}

export default {
  label: 'Dhan',
  capabilities: { portfolio: true, balance: true, orders: true, stopTarget: false },
  // Dhan needs no app keys, only the key the stored tokens are encrypted with.
  configured: () => Boolean(process.env.BROKER_TOKEN_ENCRYPTION_KEY),

  async readPortfolio(userId, { assertAccess }) {
    await assertAccess();
    return verified(userId, async (token) => {
      await assertAccess();
      const [holdings, positions, orders, trades] = await Promise.all([
        dhanHoldings(token),
        dhanGet('/positions', token),
        dhanGet('/orders', token),
        dhanGet('/trades', token),
      ]);
      const rows = brokerRows('Dhan', positions, 'position list');
      return {
        holdings: brokerRows('Dhan', holdings, 'holdings list').map((item) => ({
          symbol: symbolOf(item, 'NSE'),
          // 'ALL': a demat holding can be sold on either exchange.
          exchange: item.exchange,
          isin: item.isin || null,
          quantity: item.dpQty,
          t1Quantity: item.t1Qty ?? null,
          usedQuantity: null,
          averagePrice: item.avgCostPrice,
          lastPrice: 0,
        })),
        positions: {
          net: rows.map((item) => position(item, item.netQty, item.buyAvg, item.sellAvg)),
          day: rows
            .filter((item) => item.dayBuyQty || item.daySellQty)
            .map((item) =>
              position(
                item,
                item.dayBuyQty - item.daySellQty,
                item.dayBuyValue / item.dayBuyQty,
                item.daySellValue / item.daySellQty,
              ),
            ),
        },
        orders: brokerRows('Dhan', orders, 'order book').map((item) => {
          const state = STATUSES[item.orderStatus] ?? 'open';
          const left = item.quantity - item.filledQty;
          return {
            ...instrument(item),
            orderId: String(item.orderId ?? ''),
            product: product(item.productType),
            side: item.transactionType,
            status: item.orderStatus,
            orderType: item.orderType,
            quantity: item.quantity,
            filledQuantity: item.filledQty,
            // Dhan gives only what is left: pending while the order works, cancelled once ended.
            pendingQuantity: state === 'open' ? left : 0,
            cancelledQuantity: state === 'cancelled' ? left : 0,
            price: item.price,
            averagePrice: item.averageTradedPrice,
            placedAt: istToIso(item.createTime),
          };
        }),
        trades: brokerRows('Dhan', trades, 'trade book').map((item) => ({
          ...instrument(item),
          tradeId: String(item.exchangeTradeId ?? ''),
          orderId: String(item.orderId ?? ''),
          product: product(item.productType),
          side: item.transactionType,
          quantity: item.tradedQuantity,
          averagePrice: item.tradedPrice,
          filledAt: istToIso(item.exchangeTime) ?? istToIso(item.updateTime),
        })),
      };
    });
  },

  async readBalance(userId) {
    const funds = await verified(userId, (token) => dhanGet('/fundlimit', token));
    // "availabelBalance" is Dhan's own spelling.
    return { available: funds?.availabelBalance, used: funds?.utilizedAmount };
  },

  async placeLimitOrder(userId, { symbol, exchange, side, product: kind, quantity, price, tag }) {
    if (exchange !== 'NSE' || !ORDER_PRODUCTS[kind]) {
      throw new MarketDataError('Dhan orders here are NSE delivery (CNC) or intraday only.', 400);
    }
    const securityId = await nseSecurityId(symbol);
    const orderId = await verified(userId, (token, clientId) =>
      postOrder(token, {
        dhanClientId: clientId,
        correlationId: tag,
        transactionType: side,
        exchangeSegment: 'NSE_EQ',
        productType: ORDER_PRODUCTS[kind],
        orderType: 'LIMIT',
        validity: 'DAY',
        securityId,
        quantity,
        price,
        afterMarketOrder: false,
      }),
    );
    return { orderId };
  },

  async readOrder(userId, orderId) {
    if (!ORDER_ID.test(String(orderId))) throw new MarketDataError('Invalid order ID.', 400);
    const order = await verified(userId, (token) => dhanGet(`/orders/${orderId}`, token));
    if (
      String(order?.orderId) !== String(orderId) ||
      typeof order.orderStatus !== 'string' ||
      !Number.isSafeInteger(order.filledQty) ||
      order.filledQty < 0 ||
      !(Number.isFinite(order.averageTradedPrice) && order.averageTradedPrice >= 0)
    ) {
      throw new MarketDataError('Dhan returned an invalid order.', 502);
    }
    const reason =
      typeof order.omsErrorDescription === 'string' && order.omsErrorDescription.trim();
    return {
      status: STATUSES[order.orderStatus] ?? 'open',
      filledQuantity: order.filledQty,
      averagePrice: order.averageTradedPrice,
      message: reason ? reason.slice(0, 200) : null,
    };
  },
};
