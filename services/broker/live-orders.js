/**
 * Live orders through the member's chosen broker (its adapter in ./adapters/):
 * the server-wide switch and limits, the member's opt-in, and placing one
 * guarded DAY LIMIT order for a reviewed plan. Every check here runs the same
 * whichever broker the order goes to. The stop-loss/target GTT is in live-gtt.js.
 */
import { AccountSettings, LiveOrder, OrderPlanRecord, Trade } from '../../models/index.js';
import { riskStatus, toRiskLimits } from '../../shared/risk-limits.js';
import { getMarketStatus, todayInIst } from '../../shared/market.js';
import { getQuote } from '../market/index.js';
import { adaptersFor, brokerAdapter, memberBrokers } from './adapters/index.js';
import { applyPlatformSettings } from '../platform/settings.js';
import { HttpError } from '../errors.js';

export { toTick } from './instruments.js';

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Server-wide switch and limits. Live trading is off unless explicitly enabled and some broker
 * that can take orders is configured on this server.
 */
export async function liveTradingConfig() {
  return {
    enabled:
      process.env.LIVE_TRADING_ENABLED === 'true' &&
      (await adaptersFor('orders')).some((adapter) => adapter.configured()),
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
 * risk-limit status. `broker` is the member's live-order broker and `brokers` every broker with
 * an adapter; `enabled` also needs that broker connected and able to take orders, while
 * `serverEnabled` is the server switch alone.
 */
export async function liveTradingState(user, session) {
  const settings = await AccountSettings.findById(user._id, {
    liveTradingEnabled: 1,
    riskLimits: 1,
    liveOrderBroker: 1,
  }).lean();
  const config = await liveTradingConfig();
  const brokers = await memberBrokers(user._id);
  const chosen = settings?.liveOrderBroker ?? 'kite';
  const broker = brokers.find((item) => item.provider === chosen) ?? {
    provider: chosen,
    label: 'your broker',
    connected: false,
    capabilities: {},
  };
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
    enabled: config.enabled && broker.connected && Boolean(broker.capabilities.orders),
    serverEnabled: config.enabled,
    broker,
    brokers,
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
    if (!(await liveTradingConfig()).enabled) {
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

/** The broker the member's live orders go to: only a connected one whose adapter takes orders. */
export async function setLiveOrderBroker(user, session, provider) {
  const broker = (await memberBrokers(user._id)).find((item) => item.provider === provider);
  if (!broker?.connected || !broker.capabilities.orders) {
    throw new HttpError('Choose a connected broker that supports live orders.', 400);
  }
  await AccountSettings.updateOne(
    { _id: user._id },
    { $set: { liveOrderBroker: provider } },
    { upsert: true },
  );
  return liveTradingState(user, session);
}

/** A saved, not removed plan whose latest synced review marks it reviewed. */
export async function reviewedPlan(userId, planId) {
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
    provider: row.provider ?? 'kite',
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
 * Brokers accept an order (and return its id) before their risk checks run, so an order saved as
 * "placed" can be rejected moments later (for example for margin). Today's placed orders are
 * re-read and marked rejected, so the plan can be sent again and the daily limit is not used up.
 */
async function settleRejectedOrders(userId) {
  const placed = await LiveOrder.find(
    { userId, status: 'placed', tradingDate: todayInIst(), brokerOrderId: { $ne: null } },
    { brokerOrderId: 1, provider: 1 },
  )
    .limit(20)
    .lean();
  for (const order of placed) {
    try {
      const adapter = await brokerAdapter(order.provider ?? 'kite');
      const broker = await adapter.readOrder(userId, order.brokerOrderId);
      const dead =
        broker.status === 'rejected' || (broker.status === 'cancelled' && !broker.filledQuantity);
      if (dead) {
        const reason = broker.message ? `: ${String(broker.message).slice(0, 300)}` : '.';
        await LiveOrder.updateOne(
          { _id: order._id, status: 'placed' },
          {
            $set: {
              status: 'rejected',
              error: `${adapter.label} ${broker.status} the order${reason}`,
            },
          },
        );
      }
    } catch {
      // Unreadable now: leave it as placed (the safe direction for the daily limit).
    }
  }
}

/**
 * Send one reviewed plan to the member's live-order broker as a regular DAY LIMIT
 * order at the plan's entry price. Every safety check runs on the server against
 * the frozen plan; the browser only names the plan and confirms its symbol.
 */
export async function placeLiveOrder({
  user,
  session,
  planId,
  confirmSymbol,
  idempotencyKey,
  autoStopTarget = false,
}) {
  // Real money: read the admin's live-trading switch and limits fresh, not a cached copy.
  await applyPlatformSettings();
  await settleRejectedOrders(user._id);
  const state = await liveTradingState(user, session);
  if (!state.serverEnabled) throw new HttpError('Live trading is not enabled on this server.', 403);
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
  const { broker } = state;
  if (!state.enabled) {
    throw new HttpError(
      `Connect your ${broker.label} account in Settings before placing live orders.`,
      409,
    );
  }

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
    if (!broker.capabilities.stopTarget) {
      throw new HttpError(
        `An automatic stop-loss and target is not available with ${broker.label}.`,
        400,
      );
    }
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
      provider: broker.provider,
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
  // Count again now that this order is recorded: two requests at once both passed the check above,
  // and only one of them may use the last slot (if both see too many, both give way).
  const usedNow = await LiveOrder.countDocuments({
    userId: user._id,
    tradingDate: record.tradingDate,
    status: { $in: ['submitting', 'placed', 'unknown'] },
  });
  if (usedNow > state.dailyLimit) {
    await LiveOrder.deleteOne({ _id: record._id, status: 'submitting' });
    throw new HttpError(`Daily live order limit reached (${state.dailyLimit}).`, 429);
  }

  try {
    const adapter = await brokerAdapter(broker.provider);
    const { orderId } = await adapter.placeLimitOrder(user._id, {
      symbol,
      exchange: 'NSE',
      side,
      product,
      quantity,
      price: priceValue,
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
