/**
 * Live orders through Zerodha: the server-wide switch and limits, the member's
 * opt-in, and placing one guarded DAY LIMIT order for a reviewed plan.
 */
import { AccountSettings, LiveOrder, OrderPlanRecord, Trade, User } from '../../models/index.js';
import { riskStatus, toRiskLimits } from '../../shared/risk-limits.js';
import { getMarketStatus, todayInIst } from '../../shared/market.js';
import { getQuote, isKiteConfigured } from '../market/index.js';
import { placeKiteGtt, placeKiteLimitOrder, readKiteOrder } from '../market/kite.js';
import { HttpError } from '../errors.js';
import { accessProblem } from '../auth/accounts.js';
import { hasFeature } from '../billing/membership.js';
import { sendToMember } from '../telegram/bot.js';

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Server-wide switch and limits. Live trading is off unless explicitly enabled. */
export function liveTradingConfig() {
  return {
    enabled: process.env.LIVE_TRADING_ENABLED === 'true' && isKiteConfigured(),
    maxOrderValue: positiveNumber(process.env.LIVE_ORDER_MAX_VALUE, 50_000),
    maxQuantity: Math.floor(positiveNumber(process.env.LIVE_ORDER_MAX_QUANTITY, 1_000)),
    dailyLimit: Math.floor(positiveNumber(process.env.LIVE_ORDER_DAILY_LIMIT, 5)),
    maxPriceDeviationPercent: positiveNumber(process.env.LIVE_ORDER_MAX_PRICE_DEVIATION_PERCENT, 3),
  };
}

function mfaVerified(user, session) {
  return Boolean(user.hasVerifiedFactor?.() && session?.aal === 'aal2');
}

/**
 * The server limits plus the member's live-order state: their opt-in, MFA (aal2) status, whether
 * the market is open, today's live orders still counted against the daily limit, and today's
 * risk-limit status.
 */
export async function liveTradingState(user, session) {
  const settings = await AccountSettings.findById(user._id, {
    liveTradingEnabled: 1,
    riskLimits: 1,
  }).lean();
  const config = liveTradingConfig();
  const today = todayInIst();
  const todaysTrades = await Trade.find(
    { userId: user._id, tradeDate: today },
    { tradeDate: 1, grossPnl: 1, charges: 1, netPnl: 1 },
  ).lean();
  const usedToday = await LiveOrder.countDocuments({
    userId: user._id,
    tradingDate: today,
    status: { $in: ['submitting', 'placed', 'unknown'] },
  });
  return {
    ...config,
    accountEnabled: Boolean(settings?.liveTradingEnabled),
    mfaVerified: mfaVerified(user, session),
    marketOpen: getMarketStatus() === 'open',
    usedToday,
    risk: riskStatus(
      todaysTrades.map((row) => ({
        date: row.tradeDate,
        pnl: Number(row.netPnl ?? (row.grossPnl ?? 0) - (row.charges ?? 0)),
      })),
      toRiskLimits(settings?.riskLimits),
      today,
    ),
  };
}

/** The member's own opt-in. Turning it on requires a verified authenticator. */
export async function setLiveTrading(user, session, enabled) {
  if (enabled) {
    if (!liveTradingConfig().enabled) {
      throw new HttpError('Live trading is not enabled on this server.', 403);
    }
    if (!mfaVerified(user, session)) {
      throw new HttpError(
        'Add an authenticator in Settings and verify it before enabling live orders.',
        403,
      );
    }
  }
  await AccountSettings.updateOne(
    { _id: user._id },
    { $set: { liveTradingEnabled: Boolean(enabled) } },
    { upsert: true },
  );
  return liveTradingState(user, session);
}

/** A saved, not removed plan whose latest synced review marks it reviewed. */
async function reviewedPlan(userId, planId) {
  const plan = await OrderPlanRecord.findOne({ userId, recordKey: `plan:${planId}` }).lean();
  if (!plan)
    throw new HttpError('This plan has not reached your account yet. Wait for it to sync.', 409);
  if (await OrderPlanRecord.exists({ userId, recordKey: `removed:${planId}` })) {
    throw new HttpError('This plan was removed.', 409);
  }
  const review = await OrderPlanRecord.findOne({
    userId,
    recordKind: 'review',
    'record.id': planId,
  })
    .sort({ serverRevision: -1 })
    .lean();
  if (!review?.record?.reviewedAt) {
    throw new HttpError('Mark the plan as reviewed and let it sync before placing an order.', 409);
  }
  return plan.record;
}

/** API shape of a stored live order, with its GTT details when one was attempted. */
export function toLiveOrder(row) {
  return {
    id: row._id,
    planId: row.planId,
    status: row.status,
    symbol: row.symbol,
    side: row.side,
    product: row.product,
    quantity: row.quantity,
    price: row.price,
    orderValue: row.orderValue,
    referencePrice: row.referencePrice,
    brokerOrderId: row.brokerOrderId,
    error: row.error,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    autoGtt: Boolean(row.autoGtt),
    gtt: row.gttStatus
      ? {
          status: row.gttStatus,
          triggerId: row.gttTriggerId,
          stop: row.gttStop,
          target: row.gttTarget,
          error: row.gttError,
        }
      : null,
  };
}

/** The member's 50 most recent live orders, newest first. */
export async function listLiveOrders(userId) {
  const rows = await LiveOrder.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
  return rows.map(toLiveOrder);
}

/**
 * Send one reviewed plan to Zerodha as a regular DAY LIMIT order at the plan's
 * entry price. Every safety check runs on the server against the frozen plan;
 * the browser only names the plan and confirms its symbol.
 */
export async function placeLiveOrder({
  user,
  session,
  planId,
  confirmSymbol,
  idempotencyKey,
  autoStopTarget = false,
}) {
  const state = await liveTradingState(user, session);
  if (!state.enabled) throw new HttpError('Live trading is not enabled on this server.', 403);
  if (!state.accountEnabled) throw new HttpError('Enable live orders in Settings first.', 403);
  if (!state.mfaVerified) {
    throw new HttpError('Verify your authenticator before placing live orders.', 403);
  }
  // The member's own limits: stop for the day after the loss or trade limit.
  if (state.risk.blocked) {
    throw new HttpError(`${state.risk.reasons[0]} No more live orders today.`, 403);
  }

  const replay = await LiveOrder.findById(idempotencyKey).lean();
  if (replay) {
    if (replay.userId !== user._id || replay.planId !== planId) {
      throw new HttpError('This order request was already used.', 409);
    }
    return toLiveOrder(replay);
  }
  const active = await LiveOrder.findOne({
    userId: user._id,
    planId,
    status: { $in: ['submitting', 'placed', 'unknown'] },
  }).lean();
  if (active) throw new HttpError('An order was already sent for this plan.', 409);

  if (!state.marketOpen)
    throw new HttpError('Live orders can be placed only while the market is open.', 409);
  if (state.usedToday >= state.dailyLimit) {
    throw new HttpError(`Daily live order limit reached (${state.dailyLimit}).`, 429);
  }

  const plan = await reviewedPlan(user._id, planId);
  const symbol = String(plan.symbol || '').toUpperCase();
  if (
    String(confirmSymbol || '')
      .trim()
      .toUpperCase() !== symbol
  ) {
    throw new HttpError('Type the plan symbol exactly to confirm the order.', 400);
  }
  const side = plan.direction === 'Short' ? 'SELL' : 'BUY';
  const product = plan.product === 'CNC' ? 'CNC' : 'MIS';
  if (product === 'CNC' && side === 'SELL') {
    throw new HttpError('Delivery (CNC) short orders are not supported.', 400);
  }
  const quantity = Number(plan.estimate?.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new HttpError('The plan has no valid quantity.', 400);
  }
  if (quantity > state.maxQuantity) {
    throw new HttpError(`Quantity exceeds the live order limit of ${state.maxQuantity}.`, 400);
  }
  const price = String(plan.inputs?.entryPrice ?? '').trim();
  const priceValue = Number(price);
  if (!/^\d+(\.\d{1,2})?$/.test(price) || !(priceValue > 0)) {
    throw new HttpError('The plan entry price is not a valid limit price.', 400);
  }
  if (autoStopTarget) {
    // The GTT sells a delivery holding; checked now so the member knows before the order goes.
    if (product !== 'CNC' || side !== 'BUY') {
      throw new HttpError(
        'An automatic stop-loss and target is available for delivery (CNC) buys only.',
        400,
      );
    }
    if (!(Number(plan.inputs?.stopLoss) > 0 && Number(plan.inputs.stopLoss) < priceValue)) {
      throw new HttpError('The plan needs a stop-loss below the entry price.', 400);
    }
  }
  const orderValue = Math.round(quantity * priceValue * 100) / 100;
  if (orderValue > state.maxOrderValue) {
    throw new HttpError(
      `Order value ₹${orderValue.toLocaleString('en-IN')} exceeds the live order limit of ₹${state.maxOrderValue.toLocaleString('en-IN')}.`,
      400,
    );
  }

  let referencePrice;
  try {
    referencePrice = Number((await getQuote(symbol, user._id)).price);
  } catch {
    throw new HttpError('A current price could not be read, so no order was sent.', 503);
  }
  if (!(referencePrice > 0))
    throw new HttpError('A current price could not be read, so no order was sent.', 503);
  const deviation = (Math.abs(priceValue - referencePrice) / referencePrice) * 100;
  if (deviation > state.maxPriceDeviationPercent) {
    throw new HttpError(
      `The plan price is ${deviation.toFixed(1)}% away from the current price (₹${referencePrice}). Update the plan first.`,
      409,
    );
  }

  let record;
  try {
    record = await LiveOrder.create({
      _id: idempotencyKey,
      userId: user._id,
      planId,
      status: 'submitting',
      symbol,
      side,
      product,
      quantity,
      price,
      orderValue,
      referencePrice,
      tradingDate: todayInIst(),
      autoGtt: Boolean(autoStopTarget),
    });
  } catch (error) {
    if (error?.code === 11000) throw new HttpError('An order was already sent for this plan.', 409);
    throw error;
  }

  try {
    const { orderId } = await placeKiteLimitOrder(user._id, {
      symbol,
      side,
      product,
      quantity,
      price,
      tag: 'blank',
    });
    record.status = 'placed';
    record.brokerOrderId = orderId;
  } catch (error) {
    record.status = error?.outcome === 'unknown' ? 'unknown' : 'rejected';
    record.error = error instanceof Error ? error.message.slice(0, 400) : 'The order failed.';
  }
  await record.save();
  return toLiveOrder(record.toObject());
}

/* ------------------------------ stop-loss / target GTT ------------------------------ */

/** Kite needs each trigger at least this far (percent) from the last price. */
const GTT_MIN_DISTANCE_PERCENT = 0.25;
/** The stop leg's limit price sits this far (percent) below its trigger, to help it fill. */
const STOP_LIMIT_BUFFER_PERCENT = 0.5;
/**
 * Rounds a price to the ₹0.05 tick. Works in whole paise: dividing rupees by
 * 0.05 is inexact (100.05 / 0.05 = 2000.9999…) and would drop a tick.
 */
export function toTick(value, roundUp) {
  const paise = Math.round(value * 100);
  const ticks = roundUp ? Math.ceil(paise / 5) : Math.floor(paise / 5);
  return (ticks * 5) / 100;
}

/**
 * Places the plan's stop-loss and target on Zerodha as one GTT (one cancels the
 * other) for a filled delivery (CNC) buy placed from the plan. Same guards as
 * live orders, plus: the entry must be completely filled, the symbol typed to
 * confirm, and each trigger far enough from the current price.
 */
export async function placeStopTargetGtt({ user, session, orderId, confirmSymbol }) {
  const state = await liveTradingState(user, session);
  if (!state.enabled) throw new HttpError('Live trading is not enabled on this server.', 403);
  if (!state.accountEnabled) throw new HttpError('Enable live orders in Settings first.', 403);
  if (!state.mfaVerified) {
    throw new HttpError('Verify your authenticator before placing a GTT.', 403);
  }
  const order = await LiveOrder.findOne({ _id: orderId, userId: user._id });
  if (!order) throw new HttpError('This live order is no longer available.', 404);
  if (order.status !== 'placed' || !order.brokerOrderId) {
    throw new HttpError('Only a placed order can get a stop-loss and target.', 409);
  }
  if (order.product !== 'CNC' || order.side !== 'BUY') {
    throw new HttpError(
      'Zerodha GTTs work for delivery (CNC) holdings, so intraday (MIS) orders cannot get one. Place the stop manually in Kite.',
      409,
    );
  }
  if (order.gttStatus === 'placed' || order.gttStatus === 'unknown') {
    throw new HttpError('A GTT was already sent for this order.', 409);
  }
  if (
    String(confirmSymbol || '')
      .trim()
      .toUpperCase() !== order.symbol
  ) {
    throw new HttpError('Type the symbol exactly to confirm the GTT.', 400);
  }
  return sendStopTargetGtt(user, order);
}

/**
 * The GTT itself, after the caller's checks: the entry must be completely
 * filled (HttpError with `pending` while it is still working) and each trigger
 * far enough from the current price.
 */
async function sendStopTargetGtt(user, order) {
  const plan = await reviewedPlan(user._id, order.planId);
  const stop = Number(plan.inputs?.stopLoss);
  const target = plan.inputs?.takeProfit ? Number(plan.inputs.takeProfit) : null;
  if (!(stop > 0)) throw new HttpError('The plan has no valid stop-loss.', 400);

  let broker;
  try {
    broker = await readKiteOrder(user._id, order.brokerOrderId);
  } catch (error) {
    throw new HttpError(
      error instanceof Error ? error.message : 'The order could not be read from Zerodha.',
      error?.status === 401 ? 401 : 503,
    );
  }
  if (broker.status !== 'COMPLETE' || broker.filledQuantity !== order.quantity) {
    const error = new HttpError(
      `The entry order is not completely filled yet (${broker.filledQuantity} of ${order.quantity}, ${broker.status || 'unknown status'}).`,
      409,
    );
    // Still working at the exchange: the automatic GTT tries again on the next check.
    error.pending = !['CANCELLED', 'REJECTED'].includes(broker.status);
    throw error;
  }

  let lastPrice;
  try {
    lastPrice = Number((await getQuote(order.symbol, user._id)).price);
  } catch {
    lastPrice = NaN;
  }
  if (!(lastPrice > 0))
    throw new HttpError('A current price could not be read, so no GTT was sent.', 503);
  const farEnough = (trigger) =>
    (Math.abs(trigger - lastPrice) / lastPrice) * 100 >= GTT_MIN_DISTANCE_PERCENT;
  if (!(stop < lastPrice) || !farEnough(stop)) {
    throw new HttpError(
      `The stop (₹${stop}) must be at least ${GTT_MIN_DISTANCE_PERCENT}% below the current price (₹${lastPrice}).`,
      409,
    );
  }
  if (target !== null && (!(target > lastPrice) || !farEnough(target))) {
    throw new HttpError(
      `The target (₹${target}) must be at least ${GTT_MIN_DISTANCE_PERCENT}% above the current price (₹${lastPrice}).`,
      409,
    );
  }
  const legs = [
    // Triggers are sent on the tick too; the stop rounds down, the target up.
    {
      trigger: toTick(stop, false),
      price: toTick(stop * (1 - STOP_LIMIT_BUFFER_PERCENT / 100), false),
    },
    ...(target !== null ? [{ trigger: toTick(target, true), price: toTick(target, true) }] : []),
  ];

  // Claim the order atomically so two requests can never send two GTTs.
  const claimed = await LiveOrder.findOneAndUpdate(
    { _id: order._id, userId: user._id, gttStatus: { $in: [null, 'rejected'] } },
    { $set: { gttStatus: 'unknown', gttStop: stop, gttTarget: target, gttError: null } },
    { new: true },
  );
  if (!claimed) throw new HttpError('A GTT was already sent for this order.', 409);
  try {
    const { triggerId } = await placeKiteGtt(user._id, {
      symbol: order.symbol,
      side: 'SELL',
      product: 'CNC',
      quantity: order.quantity,
      lastPrice,
      legs,
    });
    claimed.gttStatus = 'placed';
    claimed.gttTriggerId = triggerId;
  } catch (error) {
    claimed.gttStatus = error?.outcome === 'unknown' ? 'unknown' : 'rejected';
    claimed.gttError = error instanceof Error ? error.message.slice(0, 400) : 'The GTT failed.';
  }
  await claimed.save();
  return toLiveOrder(claimed.toObject());
}

/** Orders older than this no longer get an automatic GTT (a DAY order has long expired). */
const AUTO_GTT_WINDOW_MS = 3 * 24 * 60 * 60_000;

/**
 * Scheduled during market hours: places the stop-loss/target GTT for each
 * delivery buy placed with "automatic stop and target" once its entry has
 * completely filled. The member consented when placing the order (with a
 * verified authenticator); the server switch and their opt-in are checked
 * again here. Each outcome is sent to their Telegram chat.
 */
export async function placePendingAutoGtts({ limit = 100 } = {}) {
  const config = liveTradingConfig();
  if (!config.enabled) return { checked: 0, placed: 0, failed: 0, waiting: 0, enabled: false };
  const orders = await LiveOrder.find({
    autoGtt: true,
    status: 'placed',
    gttStatus: null,
    createdAt: { $gte: new Date(Date.now() - AUTO_GTT_WINDOW_MS) },
  })
    .limit(limit)
    .lean();
  const counts = { checked: orders.length, placed: 0, failed: 0, waiting: 0, enabled: true };
  for (const order of orders) {
    const user = await User.findById(order.userId);
    const settings = await AccountSettings.findById(order.userId, { liveTradingEnabled: 1 }).lean();
    let problem = null;
    if (!user || (await accessProblem(user))) problem = 'Blank access is not active.';
    else if (!settings?.liveTradingEnabled) problem = 'Live orders were turned off in Settings.';
    else if (!(await hasFeature(user, 'liveOrders'))) problem = 'Premium has ended.';
    let result = null;
    if (!problem) {
      try {
        result = await sendStopTargetGtt(user, order);
      } catch (error) {
        // Still filling, or Zerodha/the quote briefly unreachable: try on the next check.
        if (error?.pending || error?.status === 503) {
          counts.waiting += 1;
          continue;
        }
        problem = error instanceof Error ? error.message : 'The GTT failed.';
      }
    }
    if (problem) {
      // Recorded on the order so it is not retried; the member can still place one by hand.
      await LiveOrder.updateOne(
        { _id: order._id, gttStatus: null },
        { $set: { gttStatus: 'rejected', gttError: problem.slice(0, 400) } },
      );
    }
    const placed = result?.gtt?.status === 'placed';
    if (placed) counts.placed += 1;
    else counts.failed += 1;
    await sendToMember(
      order.userId,
      placed
        ? `Stop-loss ₹${result.gtt.stop}${result.gtt.target ? ` and target ₹${result.gtt.target}` : ''} placed on Zerodha for ${order.symbol} (GTT ${result.gtt.triggerId}).`
        : `The automatic stop-loss for ${order.symbol} was NOT placed: ${problem ?? result?.gtt?.error ?? 'unknown outcome, check Kite'}. Place it in Kite now.`,
    );
  }
  return counts;
}
