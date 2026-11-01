/**
 * The stop-loss and target for a filled delivery (CNC) buy, placed with the order's broker as one
 * GTT (one cancels the other): by hand, or automatically once the entry fills.
 */
import { AccountSettings, LiveOrder, User } from '../../models/index.js';
import { todayInIst } from '../../shared/market.js';
import { getQuote } from '../market/index.js';
import { brokerAdapter } from './adapters/index.js';
import { applyPlatformSettings } from '../platform/settings.js';
import { HttpError } from '../errors.js';
import { accessProblem } from '../auth/accounts.js';
import { hasFeature } from '../billing/membership.js';
import { sendToMember } from '../telegram/bot.js';
import { liveTradingConfig, liveTradingState, reviewedPlan, toLiveOrder } from './live-orders.js';

/** Each trigger at least this far (percent) from the last price (Kite's minimum, for every broker). */
const GTT_MIN_DISTANCE_PERCENT = 0.25;

/**
 * Places the plan's stop-loss and target with the order's broker as one GTT (one
 * cancels the other) for a filled delivery (CNC) buy placed from the plan. Same
 * guards as live orders, plus: the entry must be completely filled, the symbol
 * typed to confirm, and each trigger far enough from the current price.
 */
export async function placeStopTargetGtt({ user, session, orderId, confirmSymbol }) {
  const state = await liveTradingState(user, session);
  if (!state.serverEnabled) throw new HttpError('Live trading is not enabled on this server.', 403);
  if (!state.accountEnabled) throw new HttpError('Enable live orders in Settings first.', 403);
  if (!state.mfaVerified) {
    throw new HttpError('Verify your authenticator before placing a GTT.', 403);
  }
  const order = await LiveOrder.findOne({ _id: orderId, userId: user._id });
  if (!order) throw new HttpError('This live order is no longer available.', 404);
  if (order.status !== 'placed' || !order.brokerOrderId) {
    throw new HttpError('Only a placed order can get a stop-loss and target.', 409);
  }
  const adapter = await brokerAdapter(order.provider);
  if (!adapter?.capabilities.stopTarget) {
    throw new HttpError(
      `A stop-loss and target cannot be placed with ${adapter?.label ?? 'this broker'} here. Place the stop in your broker app.`,
      409,
    );
  }
  if (order.product !== 'CNC' || order.side !== 'BUY') {
    throw new HttpError(
      `A stop-loss and target here protects a delivery (CNC) holding, so intraday (MIS) orders cannot get one. Place the stop manually in ${adapter.label}.`,
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
  return sendStopTargetGtt(user, order, adapter);
}

/**
 * The GTT itself through the order's `adapter`, after the caller's checks: the
 * entry must be completely filled (HttpError with `pending` while it is still
 * working) and each trigger far enough from the current price.
 */
async function sendStopTargetGtt(user, order, adapter) {
  const plan = await reviewedPlan(user._id, order.planId);
  const stop = Number(plan.inputs?.stopLoss);
  const target = plan.inputs?.takeProfit ? Number(plan.inputs.takeProfit) : null;
  if (!(stop > 0)) throw new HttpError('The plan has no valid stop-loss.', 400);

  let broker;
  try {
    broker = await adapter.readOrder(user._id, order.brokerOrderId);
  } catch (error) {
    throw new HttpError(
      error instanceof Error ? error.message : `The order could not be read from ${adapter.label}.`,
      error?.status === 401 ? 401 : 503,
    );
  }
  if (broker.status !== 'complete' || broker.filledQuantity !== order.quantity) {
    const error = new HttpError(
      `The entry order is not completely filled yet (${broker.filledQuantity} of ${order.quantity}, ${broker.status || 'unknown status'}).`,
      409,
    );
    // Still working at the exchange: the automatic GTT tries again on the next check.
    error.pending = !['cancelled', 'rejected'].includes(broker.status);
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

  // Claim the order atomically so two requests can never send two GTTs.
  const claimed = await LiveOrder.findOneAndUpdate(
    { _id: order._id, userId: user._id, gttStatus: { $in: [null, 'rejected'] } },
    { $set: { gttStatus: 'unknown', gttStop: stop, gttTarget: target, gttError: null } },
    { new: true },
  );
  if (!claimed) {
    throw new HttpError('A GTT was already sent for this order.', 409, { claimLost: true });
  }
  try {
    const { triggerId } = await adapter.placeStopTarget(user._id, {
      symbol: order.symbol,
      exchange: 'NSE',
      quantity: order.quantity,
      stopLoss: stop,
      target,
      lastPrice,
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
  // The admin's live-trading switch may have changed on another process a moment ago.
  await applyPlatformSettings();
  const config = await liveTradingConfig();
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
    const adapter = await brokerAdapter(order.provider ?? 'kite');
    const label = adapter?.label ?? 'your broker';
    let problem = null;
    if (!user || (await accessProblem(user))) problem = 'Blank access is not active.';
    else if (!settings?.liveTradingEnabled) problem = 'Live orders were turned off in Settings.';
    else if (!(await hasFeature(user, 'liveOrders', { startTrial: false })))
      problem = 'Premium has ended.';
    else if (!adapter?.capabilities.stopTarget)
      problem = `${label} cannot take a stop-loss and target here.`;
    let result = null;
    if (!problem) {
      try {
        result = await sendStopTargetGtt(user, order, adapter);
      } catch (error) {
        // Another run (or the member by hand) is already placing this GTT: nothing to report.
        if (error?.claimLost) continue;
        // Still filling, or the broker/the quote briefly unreachable: try on the next check.
        if (error?.pending || error?.status === 503) {
          // Once its trading day is over the order cannot fill or (often) be read any more:
          // report it rather than wait until it silently leaves the window.
          if (order.tradingDate >= todayInIst()) {
            counts.waiting += 1;
            continue;
          }
          problem = `Its entry fill could not be confirmed on its trading day (${order.tradingDate}).`;
        } else problem = error instanceof Error ? error.message : 'The GTT failed.';
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
        ? `Stop-loss ₹${result.gtt.stop}${result.gtt.target ? ` and target ₹${result.gtt.target}` : ''} placed on ${label} for ${order.symbol} (GTT ${result.gtt.triggerId}).`
        : `The automatic stop-loss for ${order.symbol} was NOT placed: ${problem ?? result?.gtt?.error ?? `unknown outcome, check ${label}`}. Place it in ${label} now.`,
    );
  }
  return counts;
}
