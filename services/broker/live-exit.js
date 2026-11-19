/**
 * Exiting a live order's position from Blank: one opposite LIMIT order for the quantity the
 * broker filled, priced a little through the current price so it fills like a market order but
 * never at any price. Intraday (MIS) orders have no stop/target GTT, so this is their way out;
 * a delivery (CNC) buy can use it too while no GTT stands for it.
 */
import { LiveOrder } from '../../models/index.js';
import { getQuote } from '../market/index.js';
import { brokerAdapter } from './adapters/index.js';
import { readBrokerPortfolio } from './portfolio.js';
import { toTick } from './instruments.js';
import { applyPlatformSettings } from '../platform/settings.js';
import { HttpError } from '../errors.js';
import { liveTradingState, toLiveOrder } from './live-orders.js';

/** How far (percent) through the current price the exit's limit sits, so it fills at once. */
export const EXIT_PRICE_BUFFER_PERCENT = 0.5;

/** The exit's limit price: below the last price for a sell, above it for a buy back. */
export function exitLimitPrice(side, lastPrice) {
  return side === 'SELL'
    ? toTick(lastPrice * (1 - EXIT_PRICE_BUFFER_PERCENT / 100), false)
    : toTick(lastPrice * (1 + EXIT_PRICE_BUFFER_PERCENT / 100), true);
}

/**
 * Shares of the order's position still open at the broker, in the entry's direction, less any
 * exit already waiting there (an order the member placed in the broker app that has not filled
 * yet). Intraday: the net MIS position. Delivery: holdings (settled and T1) plus today's net CNC
 * position.
 */
export function openQuantity(portfolio, order) {
  const same = (item) => item.exchange === 'NSE' && item.symbol === order.symbol;
  const sameProduct = (item) => same(item) && item.product === order.product;
  const net = portfolio.positions.net
    .filter(sameProduct)
    .reduce((sum, item) => sum + item.quantity, 0);
  const exitSide = order.side === 'BUY' ? 'SELL' : 'BUY';
  const waiting = portfolio.orders
    .filter((item) => sameProduct(item) && item.side === exitSide)
    .reduce((sum, item) => sum + item.pendingQuantity, 0);
  const open =
    order.product === 'MIS'
      ? order.side === 'BUY'
        ? net
        : -net
      : portfolio.holdings
          .filter(same)
          .reduce((sum, item) => sum + item.quantity + (item.t1Quantity ?? 0), net);
  return Math.max(0, open - waiting);
}

/**
 * Sends the exit for one of the member's placed live orders. Same account checks as placing an
 * order (server switch, opt-in, authenticator, typed symbol), but not the daily order limit or
 * the risk limits: closing a position only ever lowers risk, so it is never blocked by them.
 */
export async function exitLiveOrder({ user, session, orderId, confirmSymbol }) {
  await applyPlatformSettings();
  const state = await liveTradingState(user, session);
  if (!state.serverEnabled) throw new HttpError('Live trading is not enabled on this server.', 403);
  if (!state.accountEnabled) throw new HttpError('Enable live orders in Settings first.', 403);
  if (!state.mfaVerified) {
    throw new HttpError('Verify your authenticator before exiting a position.', 403);
  }
  if (!state.marketOpen) {
    throw new HttpError('A position can be exited here only while the market is open.', 409);
  }

  const order = await LiveOrder.findOne({ _id: orderId, userId: user._id });
  if (!order) throw new HttpError('This live order is no longer available.', 404);
  if (order.status !== 'placed' || !order.brokerOrderId) {
    throw new HttpError('Only a placed order can be exited.', 409);
  }
  if (order.exitStatus === 'placed' || order.exitStatus === 'unknown') {
    throw new HttpError('An exit was already sent for this order.', 409);
  }
  // A standing GTT would sell the same shares again once it triggers.
  if (order.gttStatus === 'placed' || order.gttStatus === 'unknown') {
    throw new HttpError(
      'A stop-loss and target GTT stands for this order. Exit or cancel it in your broker app.',
      409,
    );
  }
  if (
    String(confirmSymbol || '')
      .trim()
      .toUpperCase() !== order.symbol
  ) {
    throw new HttpError('Type the symbol exactly to confirm the exit.', 400);
  }

  const adapter = await brokerAdapter(order.provider ?? 'kite');
  let entry;
  try {
    entry = await adapter.readOrder(user._id, order.brokerOrderId);
  } catch (error) {
    throw new HttpError(
      error instanceof Error ? error.message : `The order could not be read from ${adapter.label}.`,
      error?.status === 401 ? 401 : 503,
    );
  }
  // Exiting only part while the rest can still fill would leave a new position behind.
  if (entry.status === 'open') {
    throw new HttpError(
      `The entry is still open at ${adapter.label} (${entry.filledQuantity} of ${order.quantity} filled). Cancel its pending part in ${adapter.label} first, then exit.`,
      409,
    );
  }
  const filled = Number(entry.filledQuantity);
  if (!Number.isSafeInteger(filled) || filled < 1 || filled > order.quantity) {
    throw new HttpError('The entry has no filled quantity to exit.', 409);
  }
  // Never more than is still open at the broker: a position already closed there (by hand, by
  // the broker's day-end square-off, or yesterday's intraday) must not turn into a new one.
  let open;
  try {
    open = openQuantity(
      await readBrokerPortfolio(user._id, async () => {}, order.provider ?? 'kite'),
      order,
    );
  } catch (error) {
    throw new HttpError(
      `Your ${adapter.label} positions could not be read, so no exit was sent. ${error instanceof Error ? error.message : ''}`.trim(),
      error?.status === 429 ? 429 : 503,
    );
  }
  const quantity = Math.min(filled, open);
  if (quantity < 1) {
    throw new HttpError(
      `${adapter.label} shows no open ${order.symbol} ${order.product} position to exit. It may already be closed.`,
      409,
    );
  }

  let lastPrice;
  try {
    lastPrice = Number((await getQuote(order.symbol, user._id)).price);
  } catch {
    lastPrice = NaN;
  }
  if (!(lastPrice > 0)) {
    throw new HttpError('A current price could not be read, so no exit was sent.', 503);
  }
  const side = order.side === 'BUY' ? 'SELL' : 'BUY';
  const price = exitLimitPrice(side, lastPrice);

  // Claim the order atomically so two requests can never send two exits. The GTT claim (in
  // live-gtt.js) needs no exit and this one needs no GTT, so only one of the two can ever win.
  const claimed = await LiveOrder.findOneAndUpdate(
    {
      _id: order._id,
      userId: user._id,
      exitStatus: { $in: [null, 'rejected'] },
      gttStatus: { $in: [null, 'rejected'] },
    },
    {
      $set: {
        exitStatus: 'unknown',
        exitQuantity: quantity,
        exitPrice: price,
        exitBrokerOrderId: null,
        exitError: null,
      },
    },
    { new: true },
  );
  if (!claimed) throw new HttpError('An exit was already sent for this order.', 409);
  try {
    const { orderId: exitOrderId } = await adapter.placeLimitOrder(user._id, {
      symbol: order.symbol,
      exchange: 'NSE',
      side,
      product: order.product,
      quantity,
      price,
      tag: 'blankexit',
    });
    claimed.exitStatus = 'placed';
    claimed.exitBrokerOrderId = exitOrderId;
  } catch (error) {
    claimed.exitStatus = error?.outcome === 'unknown' ? 'unknown' : 'rejected';
    claimed.exitError = error instanceof Error ? error.message.slice(0, 400) : 'The exit failed.';
  }
  await claimed.save();
  return toLiveOrder(claimed.toObject());
}
