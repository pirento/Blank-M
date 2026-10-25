/**
 * Angel One (SmartAPI) as a broker adapter (contract: ./index.js), on the member's own SmartAPI
 * session (../angel.js). Endpoints, fields and enums follow smartapi.angelone.in/docs (User,
 * Orders, Portfolio, Instruments, Rate Limit). SmartAPI's GTT rules have one trigger each and no
 * one-cancels-the-other link, so this adapter offers no stop-loss and target.
 */
import { HttpError } from '../../errors.js';
import { MarketDataError } from '../../market/types.js';
import { angelData, angelList, angelProduct, angelRequest } from '../angel.js';
import { brokerMessage, loadBrokerToken, withBrokerToken } from '../broker-api.js';
import { instrumentSymbol, istToIso } from '../fill-mapping.js';
import { brokerInstrument } from '../instruments.js';
import { brokerTradingDate } from '../portfolio.js';

const LABEL = 'Angel One';
/** The only instrument-list URL the Instruments docs give: a JSON array of flat objects (~40 MB). */
const SCRIP_MASTER_URL =
  'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const SCRIP_MASTER_TIMEOUT_MS = 120_000;
/** A scrip-master object is a few hundred characters; far more without its "}" is not that file. */
const MAX_OBJECT_CHARS = 64 * 1024;
const PRODUCTS = { CNC: 'DELIVERY', MIS: 'INTRADAY' };
/** SmartAPI's final order statuses (status codes AB02, AB03, AB05, AB07); all others are open. */
const FINAL = {
  complete: 'complete',
  rejected: 'rejected',
  cancelled: 'cancelled',
  'cancelled after market order': 'cancelled',
};
/** Generic SmartAPI errors (something went wrong, AMX, not specified, internal): not a refusal. */
const UNCLEAR_ERRORS = new Set(['AB1004', 'AB1007', 'AB2000', 'AB2001']);

const badPayload = () =>
  new MarketDataError(`${LABEL} returned an invalid portfolio snapshot.`, 502);
/** SmartAPI numbers come as numbers or strings ("194.00"); else NaN, which shared checks reject. */
const num = (value) =>
  typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : NaN;

/** ISO UTC of an IST stamp ("20-Oct-2020 13:10:59", or "13:27:53" on `day`); null when empty. */
function istTime(value, day) {
  if (value === '' || value === null || value === undefined) return null;
  const iso = istToIso(value, day);
  if (!iso) throw badPayload();
  return iso;
}

/** The journal's names, as for fills: equity without "-EQ", F&O as Kite-style contracts. */
function instrument(row) {
  const exchange = String(row.exchange ?? '').toUpperCase();
  const { symbol } = instrumentSymbol(LABEL, exchange, row.tradingsymbol, ['dated']);
  return { symbol: symbol ?? String(row.tradingsymbol ?? ''), exchange };
}

/** A signed position with the buy average when long and the sell average when short. */
function position(row, quantity, buyAverage, sellAverage) {
  return {
    ...instrument(row),
    product: angelProduct(row.producttype),
    quantity,
    averagePrice: quantity > 0 ? num(buyAverage) : quantity < 0 ? num(sellAverage) : 0,
    lastPrice: 0, // getPosition documents no last price
  };
}

/**
 * Runs `run(session)` once Angel One confirms (getProfile) that the session belongs to the linked
 * client code; 409 when it does not or when the session changed in between.
 */
async function verified(userId, run) {
  const linked = await loadBrokerToken(userId, 'angel');
  return withBrokerToken(userId, 'angel', LABEL, async (stored) => {
    if (stored !== linked?.token || !linked.row.brokerUserId) {
      throw new MarketDataError(`The ${LABEL} session changed. Refresh and try again.`, 409);
    }
    const session = JSON.parse(stored);
    const profile = await angelData(session, '/user/v1/getProfile', 'profile');
    if (
      String(profile?.clientcode ?? '')
        .trim()
        .toUpperCase() !== linked.row.brokerUserId
    ) {
      throw new MarketDataError(`The linked ${LABEL} account could not be verified.`, 409);
    }
    return run(session);
  });
}

/** The order may have reached Angel One: it must not be treated as refused and sent again. */
function unknownOutcome() {
  const error = new MarketDataError(
    `The order outcome is unknown. Check your ${LABEL} order book before trying again.`,
    504,
  );
  error.outcome = 'unknown';
  return error;
}

const refusedOrder = (reason) =>
  new MarketDataError(`${LABEL} rejected the order${reason ? `: ${reason}` : '.'}`, 502);

/**
 * The objects of a JSON array of flat objects, parsed one at a time as `chunks` (bytes) arrive, so
 * only the unfinished object is ever held. Throws when the array ends early or is not that shape.
 */
export async function* flatJsonObjects(chunks) {
  const decoder = new TextDecoder();
  let text = '';
  let start = -1; // index of the current object's "{" in `text`, -1 between objects
  let quoted = false;
  let escaped = false;
  let closed = false;
  for await (const chunk of chunks) {
    let index = text.length;
    text += decoder.decode(chunk, { stream: true });
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') start = index;
      else if (char === '}' && start >= 0) {
        yield JSON.parse(text.slice(start, index + 1));
        start = -1;
      } else if (char === ']' && start < 0) closed = true;
    }
    text = start < 0 ? '' : text.slice(start);
    start = start < 0 ? -1 : 0;
    if (text.length > MAX_OBJECT_CHARS) throw new Error('An object is too long.');
  }
  if (!closed || start >= 0) throw new Error('The array ended early.');
}

/** NSE equity ("-EQ") rows of Angel One's scrip master, streamed from the download. */
async function* nseEquities() {
  try {
    const response = await fetch(SCRIP_MASTER_URL, {
      signal: AbortSignal.timeout(SCRIP_MASTER_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    for await (const row of flatJsonObjects(response.body)) {
      // The docs' example says exch_seg "nse_cm"; the live file says "NSE".
      if (!['NSE', 'NSE_CM'].includes(String(row.exch_seg).toUpperCase())) continue;
      if (!String(row.symbol).endsWith('-EQ')) continue;
      // tick_size is in paise: SBIN-EQ lists "5.000000" for its ₹0.05 tick.
      yield {
        exchange: 'NSE',
        symbol: row.symbol,
        token: row.token,
        lotSize: num(row.lotsize),
        tickSize: num(row.tick_size) / 100,
      };
    }
  } catch {
    throw new MarketDataError(
      `The ${LABEL} instrument list could not be read. Try again shortly.`,
      503,
    );
  }
}

export default {
  label: LABEL,
  capabilities: { portfolio: true, balance: true, orders: true, stopTarget: false },

  async readPortfolio(userId, { tradingDate, assertAccess }) {
    await assertAccess();
    return verified(userId, async (session) => {
      const read = async (path, what) => {
        await assertAccess();
        return angelList(session, path, what);
      };
      const holdings = (await read('/portfolio/v1/getHolding', 'holding list')).map((row) => ({
        ...instrument(row),
        isin: /^[A-Z0-9]{12}$/.test(String(row.isin)) ? row.isin : null,
        quantity: num(row.quantity),
        t1Quantity: num(row.t1quantity),
        usedQuantity: null,
        averagePrice: num(row.averageprice),
        lastPrice: num(row.ltp),
      }));
      // One row per instrument and product: net is the whole position, day today's trading only.
      const positions = await read('/order/v1/getPosition', 'position list');
      const net = positions.map((row) =>
        position(row, num(row.netqty), row.totalbuyavgprice, row.totalsellavgprice),
      );
      const day = positions
        .filter((row) => num(row.buyqty) !== 0 || num(row.sellqty) !== 0)
        .map((row) =>
          position(row, num(row.buyqty) - num(row.sellqty), row.buyavgprice, row.sellavgprice),
        );
      const orders = (await read('/order/v1/getOrderBook', 'order book')).map((row) => ({
        ...instrument(row),
        orderId: String(row.orderid ?? ''),
        product: angelProduct(row.producttype),
        side: String(row.transactiontype ?? '').toUpperCase(),
        status: String(row.status ?? ''),
        orderType: String(row.ordertype ?? ''),
        quantity: num(row.quantity),
        filledQuantity: num(row.filledshares),
        // unfilledshares also counts cancelled or rejected shares; only a working order has pending.
        pendingQuantity: FINAL[String(row.status).toLowerCase()]
          ? 0
          : num(row.unfilledshares) - num(row.cancelsize),
        cancelledQuantity: num(row.cancelsize),
        price: num(row.price),
        averagePrice: num(row.averageprice),
        placedAt: istTime(row.updatetime),
      }));
      // The trade book stamps only a time: a trade's day is its order's (a book not yet cleared).
      const orderDays = new Map(
        orders
          .filter((order) => order.placedAt)
          .map((order) => [order.orderId, brokerTradingDate(Date.parse(order.placedAt))]),
      );
      const trades = (await read('/order/v1/getTradeBook', 'trade book')).map((row) => ({
        ...instrument(row),
        tradeId: String(row.fillid ?? ''),
        orderId: String(row.orderid ?? ''),
        product: angelProduct(row.producttype),
        side: String(row.transactiontype ?? '').toUpperCase(),
        quantity: num(row.fillsize),
        averagePrice: num(row.fillprice),
        filledAt: istTime(row.filltime, orderDays.get(String(row.orderid)) ?? tradingDate),
      }));
      return { holdings, positions: { net, day }, orders, trades };
    });
  },

  async readBalance(userId) {
    return verified(userId, async (session) => {
      const funds = await angelData(session, '/user/v1/getRMS', 'balance');
      // getRMS `net`: what is left to trade with after the margin already used.
      return { available: num(funds?.net) };
    });
  },

  async placeLimitOrder(userId, { symbol, exchange, side, product, quantity, price, tag }) {
    if (
      exchange !== 'NSE' ||
      !PRODUCTS[product] ||
      !['BUY', 'SELL'].includes(side) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      !(Number.isFinite(price) && price > 0 && Math.round(price * 100) / 100 === price)
    ) {
      throw new MarketDataError(`${LABEL} orders here are NSE equity CNC or MIS only.`, 400);
    }
    const scrip = await brokerInstrument('angel', 'NSE', `${symbol}-EQ`, nseEquities);
    if (!scrip) throw new MarketDataError(`${LABEL} does not list ${symbol} as NSE equity.`, 400);
    return verified(userId, async (session) => {
      let reply;
      try {
        reply = await angelRequest(session, '/order/v1/placeOrder', {
          method: 'POST',
          body: {
            variety: 'NORMAL',
            tradingsymbol: scrip.symbol,
            symboltoken: scrip.token,
            transactiontype: side,
            exchange: 'NSE',
            ordertype: 'LIMIT',
            producttype: PRODUCTS[product],
            duration: 'DAY',
            price: price.toFixed(2),
            quantity: String(quantity),
            ordertag: String(tag).slice(0, 19), // SmartAPI: under 20 characters
          },
        });
      } catch (error) {
        // getProfile just accepted this session, so a 401/403 here is a refusal (static IP, rate
        // limit), not an ended session: the connection stays linked.
        if (error.tokenRejected) {
          throw new HttpError(
            `${LABEL} refused the order. Check that this server's static IP is registered on your SmartAPI app.`,
            403,
          );
        }
        if (error.status === 429) throw error;
        if (error.httpStatus >= 400 && error.httpStatus < 500) {
          throw refusedOrder(brokerMessage(error.body));
        }
        throw unknownOutcome();
      }
      const { orderid, uniqueorderid } = reply?.data ?? {};
      const orderNumber = Number.isSafeInteger(orderid) ? String(orderid) : orderid;
      // Both IDs: the order ID the member sees in Angel One, then the one its status is read by.
      if (
        typeof orderNumber === 'string' &&
        typeof uniqueorderid === 'string' &&
        /^[A-Za-z0-9]{1,40}$/.test(orderNumber) &&
        /^[A-Za-z0-9-]{1,59}$/.test(uniqueorderid)
      ) {
        return { orderId: `${orderNumber}-${uniqueorderid}` };
      }
      // Only an explicit refusal is one; any other reply may still have placed the order.
      const refused =
        (reply?.status === false || reply?.status === 'false') &&
        !UNCLEAR_ERRORS.has(String(reply.errorcode ?? reply.errorCode ?? ''));
      if (!refused) throw unknownOutcome();
      throw refusedOrder(brokerMessage(reply));
    });
  },

  async readOrder(userId, orderId) {
    const [, orderid, uniqueId] = /^([A-Za-z0-9]{1,40})-([A-Za-z0-9-]{1,59})$/.exec(orderId) ?? [];
    if (!uniqueId) throw new MarketDataError('Invalid order ID.', 400);
    // No getProfile here: it allows 3 calls a second and the shared code reads orders in a loop.
    return withBrokerToken(userId, 'angel', LABEL, async (stored) => {
      const order = await angelData(JSON.parse(stored), `/order/v1/details/${uniqueId}`, 'order');
      const quantity = num(order?.quantity);
      const filledQuantity = num(order?.filledshares);
      const averagePrice = num(order?.averageprice);
      if (
        String(order?.orderid ?? '') !== orderid ||
        !Number.isSafeInteger(quantity) ||
        !Number.isSafeInteger(filledQuantity) ||
        filledQuantity < 0 ||
        !(averagePrice >= 0)
      ) {
        throw new MarketDataError(`The order could not be read from ${LABEL}.`, 502);
      }
      const status = FINAL[String(order.status).toLowerCase()] ?? 'open';
      const ended = status === 'rejected' || status === 'cancelled';
      return {
        // Complete only when every share filled; anything less is still working.
        status: status === 'complete' && filledQuantity !== quantity ? 'open' : status,
        filledQuantity,
        averagePrice,
        message: ended
          ? String(order.text ?? '')
              .trim()
              .slice(0, 300) || null
          : null,
      };
    });
  },
};
