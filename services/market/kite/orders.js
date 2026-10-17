/**
 * Order mutations on Kite: regular LIMIT orders and GTT (good-till-triggered)
 * stop-loss/target triggers, plus reading one order's status. Every mutation
 * re-verifies the linked broker identity first; callers must apply all other
 * safety checks.
 */
import { MarketDataError } from '../types.js';
import { kiteFetch, throwAuthFailure } from './client.js';
import { API_BASE, TIMEOUT_MS, isKiteConfigured } from './config.js';
import { loadConnection } from './connection.js';

/** The member's live connection after confirming the broker identity it belongs to. */
async function verifiedConnection(userId) {
  if (!isKiteConfigured()) throw new MarketDataError('Zerodha Kite is not configured.', 503);
  const connection = await loadConnection(userId, true);
  if (!connection?.brokerUserId || connection.expiresAt.getTime() <= Date.now()) {
    throw new MarketDataError('Connect your Zerodha account in Settings first.', 409);
  }
  const profile = await kiteFetch('/user/profile', connection, userId, 16 * 1024);
  if (profile?.status !== 'success' || profile.data?.user_id !== connection.brokerUserId) {
    throw new MarketDataError('The linked broker account identity could not be verified.', 409);
  }
  return connection;
}

/**
 * One form-encoded POST to Kite. A transport failure is reported with
 * `outcome: 'unknown'`, because the request may still have reached Zerodha.
 * `what` names the request in messages ("order", "GTT").
 */
async function kitePost(userId, connection, path, fields, what) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `token ${process.env.KITE_API_KEY}:${connection.accessToken}`,
        'X-Kite-Version': '3',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields),
    });
  } catch {
    const error = new MarketDataError(
      what === 'order'
        ? 'The order outcome is unknown. Check your Zerodha order book before trying again.'
        : `The ${what} outcome is unknown. Check your Zerodha GTT list before trying again.`,
      504,
    );
    error.outcome = 'unknown';
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    await throwAuthFailure(response, userId, connection);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status !== 'success') {
    // Kite's own message explains rejections such as margin or circuit limits.
    const message = typeof payload?.message === 'string' ? payload.message.slice(0, 300) : null;
    throw new MarketDataError(
      message ? `Zerodha rejected the ${what}: ${message}` : `Zerodha returned ${response.status}`,
      response.status === 429 ? 429 : 502,
    );
  }
  return payload.data;
}

/**
 * Place one regular LIMIT order after re-verifying the linked broker identity.
 * Returns { orderId } or throws. A transport failure is reported as `unknown`,
 * because the order may still have reached the exchange.
 */
export async function placeKiteLimitOrder(userId, order) {
  const connection = await verifiedConnection(userId);
  const data = await kitePost(
    userId,
    connection,
    '/orders/regular',
    {
      tradingsymbol: order.symbol,
      exchange: 'NSE',
      transaction_type: order.side,
      order_type: 'LIMIT',
      quantity: String(order.quantity),
      product: order.product,
      price: order.price,
      validity: 'DAY',
      tag: order.tag,
    },
    'order',
  );
  if (typeof data?.order_id !== 'string')
    throw new MarketDataError('Zerodha returned no order ID.', 502);
  return { orderId: data.order_id };
}

/** Latest state of one order: { status, quantity, filledQuantity, averagePrice }. */
export async function readKiteOrder(userId, orderId) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(orderId))) {
    throw new MarketDataError('Invalid order ID.', 400);
  }
  const connection = await verifiedConnection(userId);
  const payload = await kiteFetch(`/orders/${orderId}`, connection, userId, 256 * 1024);
  const history = Array.isArray(payload?.data) ? payload.data : [];
  const latest = history.at(-1);
  if (payload?.status !== 'success' || !latest) {
    throw new MarketDataError('The order could not be read from Zerodha.', 502);
  }
  return {
    status: String(latest.status ?? ''),
    quantity: Number(latest.quantity),
    filledQuantity: Number(latest.filled_quantity),
    averagePrice: Number(latest.average_price),
  };
}

/**
 * Place a GTT that sells (or buys back) `quantity` when a trigger is reached:
 * two legs (stop and target, one cancels the other) or a single stop leg.
 * legs: [{ trigger, price }] in ascending trigger order for two-leg GTTs.
 * Returns { triggerId }.
 */
export async function placeKiteGtt(userId, { symbol, side, product, quantity, lastPrice, legs }) {
  const connection = await verifiedConnection(userId);
  const data = await kitePost(
    userId,
    connection,
    '/gtt/triggers',
    {
      type: legs.length === 2 ? 'two-leg' : 'single',
      condition: JSON.stringify({
        exchange: 'NSE',
        tradingsymbol: symbol,
        trigger_values: legs.map((leg) => leg.trigger),
        last_price: lastPrice,
      }),
      orders: JSON.stringify(
        legs.map((leg) => ({
          exchange: 'NSE',
          tradingsymbol: symbol,
          transaction_type: side,
          quantity,
          order_type: 'LIMIT',
          product,
          price: leg.price,
        })),
      ),
    },
    'GTT',
  );
  const triggerId = data?.trigger_id;
  if (!Number.isSafeInteger(triggerId) && typeof triggerId !== 'string') {
    throw new MarketDataError('Zerodha returned no GTT ID.', 502);
  }
  return { triggerId: String(triggerId) };
}
