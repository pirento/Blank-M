/**
 * Broker adapters: one file per broker in this folder, named after its provider (`kite.js`,
 * `dhan.js`, `upstox.js`, `fyers.js`, `angel.js`) and found by that name, so adding a broker
 * never touches shared code. The shared code (services/broker/portfolio.js and live-orders.js)
 * runs every check that does not depend on the broker, identically for all of them: membership
 * and app session, the server switch, the member's opt-in, the authenticator (aal2), risk
 * limits, the idempotency key, one active order per plan, market hours, the daily limit, the
 * maximum quantity and value, the price check against a fresh quote, the typed symbol and the
 * atomic stop/target claim. An adapter only talks to its broker.
 *
 * An adapter file default-exports an object with:
 *
 *   label: string  Required. The broker's member-facing name, used in messages ('Zerodha').
 *   capabilities: { portfolio, balance, orders, stopTarget }  Required booleans. Each true one
 *     needs its methods below (orders: placeLimitOrder and readOrder); stopTarget needs orders.
 *   configured?(): boolean  Whether the server has what this broker needs (app keys); default
 *     true. A member's broker counts as connected when this is true and their BrokerConnection
 *     row for the provider holds an unexpired token.
 *
 *   readPortfolio(userId, { tradingDate, assertAccess }) → Promise<{
 *       holdings: [{ symbol, exchange, isin: string|null, quantity, t1Quantity: int|null,
 *                    usedQuantity: int|null, averagePrice, lastPrice }],
 *       positions: { net: [Position], day: [Position] },
 *         Position = { symbol, exchange, product, quantity (signed int), averagePrice, lastPrice }
 *       orders: [{ symbol, exchange, orderId, product, side: 'BUY'|'SELL', status, orderType,
 *                  quantity, filledQuantity, pendingQuantity, cancelledQuantity, price,
 *                  averagePrice, placedAt: ISO 8601 UTC string ('…Z')|null }],
 *       trades: [{ symbol, exchange, tradeId, orderId, product, side: 'BUY'|'SELL',
 *                  quantity (> 0), averagePrice, filledAt: ISO 8601 UTC string|null }] }>
 *     Read-only GETs, never an order mutation. Field names and rules exactly as
 *     shared/broker-portfolio.js validates them; every field is required (null only where shown).
 *     symbol/exchange/product/status/orderType match /^[A-Za-z0-9 _./&^=:+-]{1,80}$/, orderId and
 *     tradeId /^[A-Za-z0-9_-]{1,100}$/, isin /^[A-Z0-9]{12}$/. Quantities are integers (≥ 0,
 *     except signed position quantities); prices are rupees as non-negative numbers (0 when the
 *     broker gives none). A failed or unreadable section rejects the whole read: never return an
 *     empty section instead. `tradingDate` is today's IST date (YYYY-MM-DD); orders and trades
 *     stamped on another IST day are dropped by the shared code. `assertAccess()` re-checks the
 *     member's access and app session: call it between slow broker steps (the shared code calls
 *     it once the read is done). The shared code then adds source, currency, startedAt,
 *     fetchedAt and tradingDate, validates every row (an invalid row or a duplicate holding,
 *     position, order or trade key rejects the read with 502), checks filled + pending +
 *     cancelled ≤ quantity, and enforces the 5,000-row and 4 MB limits.
 *
 *   readBalance(userId) → Promise<{ available: number, used?: number, total?: number }>
 *     The equity cash balance in rupees, read-only; finite numbers (available may be negative).
 *
 *   placeLimitOrder(userId, { symbol, exchange: 'NSE', side: 'BUY'|'SELL', product: 'CNC'|'MIS',
 *                             quantity: int > 0, price: rupees (≤ 2 decimals), tag: string })
 *       → Promise<{ orderId: string }>
 *     Exactly one regular LIMIT order with DAY validity (never market, AMO, cover or bracket),
 *     after re-verifying that the stored token still belongs to the linked broker account.
 *     Refuse an exchange or product it cannot place as given. Throw on every refusal. When the
 *     order may have reached the broker without a confirmed ID (timeout, 5xx, unreadable reply,
 *     accepted without an ID) throw an error with `outcome = 'unknown'`: the order is then kept
 *     as active and the plan is not sent twice.
 *
 *   readOrder(userId, orderId) → Promise<{ status: 'open'|'complete'|'rejected'|'cancelled',
 *       filledQuantity: int, averagePrice: number, message: string|null }>
 *     The order's latest state. 'complete' only when completely filled; every not-final broker
 *     status (pending, trigger pending, partly filled, modified…) is 'open'. message: the
 *     broker's reason for a rejection or cancellation, or null.
 *
 *   placeStopTarget(userId, { symbol, exchange: 'NSE', quantity: int > 0, stopLoss: rupees,
 *                             target: rupees|null, lastPrice: rupees })
 *       → Promise<{ triggerId: string }>
 *     One standing sell OCO for a delivery (CNC) holding: a stop-loss leg below lastPrice and,
 *     unless target is null, a target leg above it; when one triggers the broker cancels the
 *     other. Round triggers to the tick (toTick in ../instruments.js: the stop down, the target
 *     up). Same `outcome = 'unknown'` rule as placeLimitOrder. The shared code has already
 *     checked the complete fill, the typed symbol, and that each trigger is at least 0.25% from
 *     lastPrice.
 *
 * Errors: throw HttpError (services/errors.js) or MarketDataError (services/market/types.js)
 * with a member-friendly message that names the broker, and a status: 409 not connected, 429
 * rate limited, 502 invalid reply, 503 not configured or unavailable, 504 timed out. A token the
 * broker refuses goes through the existing flow: make broker calls inside withBrokerToken
 * (../broker-api.js), whose brokerRequest throws tokenRejectedError (401) and then marks the
 * connection expired so the member reconnects. Instrument tokens stay inside the adapter
 * (cache the broker's master with brokerInstrument in ../instruments.js). Never log or return
 * access tokens. Adapters must not import this file.
 */
import { existsSync } from 'node:fs';
import { BrokerConnection } from '../../../models/index.js';
import { BROKER_PROVIDERS } from '../../../shared/broker-portfolio.js';
import { HttpError } from '../../errors.js';

export { BROKER_PROVIDERS };

const NEEDS = {
  portfolio: ['readPortfolio'],
  balance: ['readBalance'],
  orders: ['placeLimitOrder', 'readOrder'],
  stopTarget: ['placeStopTarget'],
};
const overrides = new Map();
let loading = null;

/** The adapter with its provider, boolean capabilities and configured(); throws on a broken contract. */
function checked(provider, adapter) {
  const capabilities = Object.fromEntries(
    Object.keys(NEEDS).map((name) => [name, adapter?.capabilities?.[name] === true]),
  );
  const broken =
    typeof adapter?.label !== 'string' ||
    (capabilities.stopTarget && !capabilities.orders) ||
    Object.entries(NEEDS).some(
      ([name, methods]) =>
        capabilities[name] && methods.some((method) => typeof adapter[method] !== 'function'),
    );
  if (broken) throw new Error(`The ${provider} broker adapter does not follow adapters/index.js.`);
  return { ...adapter, provider, capabilities, configured: adapter.configured ?? (() => true) };
}

/** Each provider's adapter file, loaded once on first use (adapters import shared broker code). */
function registry() {
  loading ??= Promise.all(
    BROKER_PROVIDERS.map(async (provider) => {
      const file = new URL(`./${provider}.js`, import.meta.url);
      return existsSync(file) ? checked(provider, (await import(file.href)).default) : null;
    }),
  );
  return loading;
}

async function all() {
  const loaded = await registry();
  return BROKER_PROVIDERS.map((provider, index) => overrides.get(provider) ?? loaded[index]).filter(
    Boolean,
  );
}

/** The adapter for 'kite' | 'dhan' | 'upstox' | 'fyers' | 'angel', or null when there is none. */
export async function brokerAdapter(provider) {
  return (await all()).find((adapter) => adapter.provider === provider) ?? null;
}

/** The adapters with `capability` (all of them without one), Zerodha first. */
export async function adaptersFor(capability) {
  return (await all()).filter((adapter) => !capability || adapter.capabilities[capability]);
}

/** Every broker with an adapter: { provider, label, connected, capabilities } for this member. */
export async function memberBrokers(userId) {
  const linked = new Set(
    (
      await BrokerConnection.find(
        { userId, accessTokenCiphertext: { $gt: '' }, expiresAt: { $gt: new Date() } },
        { provider: 1 },
      ).lean()
    ).map((row) => row.provider),
  );
  return (await all()).map((adapter) => ({
    provider: adapter.provider,
    label: adapter.label,
    connected: linked.has(adapter.provider) && adapter.configured(),
    capabilities: adapter.capabilities,
  }));
}

/**
 * The adapter serving `capability` for this member: `provider` when given (400 when it cannot),
 * else their first connected broker that can (Zerodha first), else the first that can at all,
 * whose own error then says what to connect.
 */
export async function brokerFor(userId, capability, provider) {
  if (provider) {
    const adapter = await brokerAdapter(provider);
    if (!adapter?.capabilities[capability]) {
      throw new HttpError(`This is not available for ${adapter?.label ?? 'that broker'} yet.`, 400);
    }
    return adapter;
  }
  const connected = new Set(
    (await memberBrokers(userId)).filter((item) => item.connected).map((item) => item.provider),
  );
  const adapters = await adaptersFor(capability);
  const adapter = adapters.find((item) => connected.has(item.provider)) ?? adapters[0];
  if (!adapter) throw new HttpError('No broker offers this yet.', 400);
  return adapter;
}

/** Tests only: uses `adapter` for `provider` instead of its file; null restores the file's. */
export function setBrokerAdapterForTests(provider, adapter) {
  if (process.env.NODE_ENV === 'production' || !BROKER_PROVIDERS.includes(provider)) {
    throw new Error('setBrokerAdapterForTests is for tests only.');
  }
  if (adapter) overrides.set(provider, checked(provider, adapter));
  else overrides.delete(provider);
}
