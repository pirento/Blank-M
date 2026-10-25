// @vitest-environment node
// The broker-adapter registry: a fake in-memory adapter registered for Dhan proves that the
// portfolio, balance, live orders, order settlement and stop/target go through the chosen
// broker's adapter, with every shared safety check still applied.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const kite = vi.hoisted(() => ({
  place: vi.fn(),
  gtt: vi.fn(),
  read: vi.fn(),
  balance: vi.fn(),
  quote: vi.fn(),
  market: { status: 'open' },
}));
vi.mock('../../services/market/kite.js', async (original) => ({
  ...(await original()),
  placeKiteLimitOrder: kite.place,
  placeKiteGtt: kite.gtt,
  readKiteOrder: kite.read,
  readBrokerBalance: kite.balance,
}));
vi.mock('../../services/market/index.js', async (original) => ({
  ...(await original()),
  getQuote: kite.quote,
}));
const telegram = vi.hoisted(() => ({ sent: [] }));
vi.mock('../../services/telegram/bot.js', async (original) => ({
  ...(await original()),
  sendToMember: async (userId, text) => {
    telegram.sent.push({ userId, text });
    return true;
  },
}));
vi.mock('../../shared/market.js', async (original) => ({
  ...(await original()),
  getMarketStatus: () => kite.market.status,
}));

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const { exportOrderPlanRecords, saveOrderPlan, setOrderPlanReviewed } =
  await import('../../shared/order-plans.js');
const { calculateRiskPlan } = await import('../../shared/risk-calculator.js');
const { DEFAULT_CHARGES } = await import('../../shared/types.js');
const { currentStep, totpCode } = await import('../../services/auth/totp.js');
const { placePendingAutoGtts } = await import('../../services/broker/live-orders.js');
const { setBrokerAdapterForTests } = await import('../../services/broker/adapters/index.js');
const { BrokerConnection, LiveOrder } = await import('../../models/index.js');

const ENV = {
  KITE_API_KEY: 'test-key',
  KITE_API_SECRET: 'test-secret',
  KITE_REDIRECT_URI: 'http://localhost:3000/api/kite/callback',
  BROKER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  LIVE_TRADING_ENABLED: 'true',
  LIVE_ORDER_MAX_VALUE: '50000',
};

/** An in-memory Dhan adapter; `capabilities` and methods can be overridden per test. */
function fakeDhan(overrides = {}) {
  const now = () => new Date().toISOString();
  return {
    label: 'Dhan',
    capabilities: { portfolio: true, balance: true, orders: true, stopTarget: true },
    readPortfolio: vi.fn(async () => ({
      holdings: [
        {
          symbol: 'INFY',
          exchange: 'NSE',
          isin: 'INE009A01021',
          quantity: 4,
          t1Quantity: 0,
          usedQuantity: null,
          averagePrice: 1500,
          lastPrice: 1510.5,
        },
      ],
      positions: { net: [], day: [] },
      orders: [
        {
          symbol: 'INFY',
          exchange: 'NSE',
          orderId: 'D1',
          product: 'CNC',
          side: 'BUY',
          status: 'TRADED',
          orderType: 'LIMIT',
          quantity: 4,
          filledQuantity: 4,
          pendingQuantity: 0,
          cancelledQuantity: 0,
          price: 1500,
          averagePrice: 1500,
          placedAt: now(),
        },
      ],
      trades: [
        {
          symbol: 'INFY',
          exchange: 'NSE',
          tradeId: 'T1',
          orderId: 'D1',
          product: 'CNC',
          side: 'BUY',
          quantity: 4,
          averagePrice: 1500,
          filledAt: now(),
        },
        // Yesterday's fill, still listed before the broker clears its books: dropped.
        {
          symbol: 'TCS',
          exchange: 'NSE',
          tradeId: 'T0',
          orderId: 'D0',
          product: 'CNC',
          side: 'BUY',
          quantity: 1,
          averagePrice: 3000,
          filledAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        },
      ],
    })),
    readBalance: vi.fn(async () => ({ available: 12345.5, used: 100 })),
    placeLimitOrder: vi.fn(async () => ({ orderId: 'DHAN-1' })),
    readOrder: vi.fn(async () => ({
      status: 'open',
      filledQuantity: 0,
      averagePrice: 0,
      message: null,
    })),
    placeStopTarget: vi.fn(async () => ({ triggerId: 'OCO-1' })),
    ...overrides,
  };
}

let app;
let dhan;
beforeAll(async () => {
  Object.assign(process.env, ENV);
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of Object.keys(ENV)) delete process.env[key];
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  for (const mock of [kite.place, kite.gtt, kite.read]) mock.mockReset();
  kite.balance.mockReset().mockResolvedValue({ liveBalance: 5000 });
  kite.quote.mockReset().mockResolvedValue({ price: 100.2 });
  kite.market.status = 'open';
  telegram.sent = [];
  dhan = fakeDhan();
  setBrokerAdapterForTests('dhan', dhan);
  const store = new Map();
  globalThis.window = {
    localStorage: {
      get length() {
        return store.size;
      },
      key: (index) => [...store.keys()][index] ?? null,
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    dispatchEvent: () => true,
  };
});
afterEach(() => setBrokerAdapterForTests('dhan', null));

const link = (userId, provider) =>
  BrokerConnection.create({
    userId,
    provider,
    accessTokenCiphertext: 'sealed',
    expiresAt: new Date(Date.now() + 60 * 60_000),
    brokerUserId: `${provider}-client`,
  });

/** A signed-in member with the given brokers linked, optionally with MFA and the live opt-in. */
async function member({ brokers = ['dhan'], mfa = false, optIn = false } = {}) {
  const created = await createMember({ email: 'trader@example.com' });
  for (const provider of brokers) await link(created.user._id, provider);
  const session = await signIn(app, { email: 'trader@example.com', password: created.password });
  const send = (method, path, body) =>
    session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body);
  if (mfa) {
    const enrol = await send('post', '/auth/mfa/enroll', {});
    await send('post', '/auth/mfa/verify', {
      factorId: enrol.body.id,
      code: totpCode(enrol.body.secret, currentStep()),
    });
  }
  if (optIn)
    expect((await send('put', '/api/account/live-trading', { enabled: true })).status).toBe(200);
  return { ...session, send, userId: created.user._id };
}

/** A member whose live orders go to Dhan. */
async function dhanTrader() {
  const account = await member({ mfa: true, optIn: true });
  const chosen = await account.send('put', '/api/account/live-order-broker', { broker: 'dhan' });
  expect(chosen.status).toBe(200);
  expect(chosen.body.state).toMatchObject({
    enabled: true,
    broker: { provider: 'dhan', label: 'Dhan', connected: true },
  });
  return account;
}

async function syncedPlan(account, { product = 'MIS', takeProfit = '', symbol = 'RELIANCE' } = {}) {
  const inputs = {
    direction: 'Long',
    accountSize: '100000',
    availableCapital: '20000',
    riskPercent: '1',
    entryPrice: '100',
    stopLoss: '95',
    takeProfit,
    product,
    marginPercent: '100',
    ...(product === 'CNC' ? { estimatedRoundTripCharges: '40' } : {}),
  };
  const plan = saveOrderPlan(account.userId, {
    symbol,
    direction: 'Long',
    product,
    inputs,
    estimate: calculateRiskPlan(inputs, DEFAULT_CHARGES).plan,
    chargesSnapshot: { ...DEFAULT_CHARGES },
    strategySnapshot: null,
    rulesSnapshot: [],
    quoteSnapshot: null,
  });
  setOrderPlanReviewed(account.userId, plan.id, true);
  for (const record of exportOrderPlanRecords(account.userId)) {
    expect((await account.send('post', '/api/order-plans', record)).status).toBeLessThan(300);
  }
  return plan;
}

const place = (account, plan, overrides = {}) =>
  account.send('post', '/api/live-orders', {
    planId: plan.id,
    confirmSymbol: plan.symbol,
    idempotencyKey: randomUUID(),
    ...overrides,
  });

describe('broker registry', () => {
  it('refuses an adapter that breaks the contract', () => {
    expect(() =>
      setBrokerAdapterForTests('dhan', { label: 'Dhan', capabilities: { orders: true } }),
    ).toThrow(/does not follow/);
  });

  it('lists each broker with its capabilities and connection', async () => {
    const account = await member();
    const { brokers } = (await account.agent.get('/api/brokers')).body;
    expect(brokers).toEqual([
      expect.objectContaining({ provider: 'kite', label: 'Zerodha', connected: false }),
      {
        provider: 'dhan',
        label: 'Dhan',
        connected: true,
        capabilities: { portfolio: true, balance: true, orders: true, stopTarget: true },
      },
      {
        provider: 'angel',
        label: 'Angel One',
        connected: false,
        capabilities: { portfolio: true, balance: true, orders: true, stopTarget: false },
      },
    ]);
  });
});

describe('portfolio and balance dispatch', () => {
  it('reads the portfolio through the adapter and validates it in shared code', async () => {
    const account = await member();
    // Only Dhan is linked, so it is the default.
    const response = await account.agent.get('/api/kite/portfolio');
    expect(response.status).toBe(200);
    expect(dhan.readPortfolio).toHaveBeenCalledOnce();
    expect(dhan.readPortfolio.mock.calls[0][1]).toMatchObject({
      tradingDate: response.body.tradingDate,
    });
    expect(response.body).toMatchObject({
      source: 'dhan',
      currency: 'INR',
      holdings: [{ symbol: 'INFY', quantity: 4 }],
      orders: [{ orderId: 'D1' }],
      trades: [{ tradeId: 'T1' }],
    });

    dhan.readPortfolio.mockResolvedValueOnce({
      holdings: [{ symbol: 'INFY', exchange: 'NSE', quantity: -1 }],
      positions: { net: [], day: [] },
      orders: [],
      trades: [],
    });
    const invalid = await account.agent.get('/api/kite/portfolio?provider=dhan');
    expect(invalid.status).toBe(502);
    expect(invalid.body.error).toBe('Dhan returned an invalid portfolio snapshot.');
    expect((await account.agent.get('/api/kite/portfolio?provider=nse')).status).toBe(400);
  });

  it('reads the balance from the default broker (Zerodha first) or the one asked for', async () => {
    const account = await member({ brokers: ['kite', 'dhan'] });
    const zerodha = await account.agent.get('/api/kite/balance');
    expect(zerodha.body).toMatchObject({ source: 'kite', label: 'Zerodha', liveBalance: 5000 });
    const picked = await account.agent.get('/api/kite/balance?provider=dhan');
    expect(picked.status).toBe(200);
    expect(picked.body).toMatchObject({
      source: 'dhan',
      label: 'Dhan',
      liveBalance: 12345.5,
      used: 100,
      currency: 'INR',
    });

    dhan.readBalance.mockResolvedValueOnce({ available: Number.NaN });
    expect((await account.agent.get('/api/kite/balance?provider=dhan')).status).toBe(502);
  });

  it('refuses a broker whose adapter does not offer the read', async () => {
    setBrokerAdapterForTests(
      'dhan',
      fakeDhan({ capabilities: { portfolio: false, balance: false, orders: false } }),
    );
    const account = await member();
    const refused = await account.agent.get('/api/kite/balance?provider=dhan');
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/not available for Dhan/);
    expect((await account.agent.get('/api/kite/portfolio?provider=dhan')).status).toBe(400);
  });
});

describe('live orders through an adapter', () => {
  it('places the guarded LIMIT order with the chosen broker', async () => {
    const account = await dhanTrader();
    const plan = await syncedPlan(account);
    const idempotencyKey = randomUUID();
    const response = await place(account, plan, { idempotencyKey });
    expect(response.status).toBe(201);
    expect(response.body.order).toMatchObject({
      provider: 'dhan',
      status: 'placed',
      brokerOrderId: 'DHAN-1',
    });
    expect(dhan.placeLimitOrder).toHaveBeenCalledWith(account.userId, {
      symbol: 'RELIANCE',
      exchange: 'NSE',
      side: 'BUY',
      product: 'MIS',
      quantity: plan.estimate.quantity,
      price: 100,
      tag: 'blank',
    });
    expect(kite.place).not.toHaveBeenCalled();
    // Idempotency and one active order per plan, whatever the broker.
    expect((await place(account, plan, { idempotencyKey })).body.order.id).toBe(idempotencyKey);
    expect((await place(account, plan)).status).toBe(409);
    expect(dhan.placeLimitOrder).toHaveBeenCalledOnce();
  });

  it('applies every shared safety check before the adapter is called', async () => {
    const account = await dhanTrader();
    const plan = await syncedPlan(account);
    expect((await place(account, plan, { confirmSymbol: 'TCS' })).status).toBe(400);
    kite.market.status = 'closed-hours';
    expect((await place(account, plan)).status).toBe(409);
    kite.market.status = 'open';
    kite.quote.mockResolvedValueOnce({ price: 120 });
    expect((await place(account, plan)).body.error).toMatch(/away from the current price/);
    process.env.LIVE_ORDER_MAX_VALUE = '1000';
    try {
      expect((await place(account, plan)).body.error).toMatch(/exceeds the live order limit/);
    } finally {
      process.env.LIVE_ORDER_MAX_VALUE = ENV.LIVE_ORDER_MAX_VALUE;
    }
    process.env.LIVE_TRADING_ENABLED = 'false';
    try {
      expect((await place(account, plan)).status).toBe(403);
    } finally {
      process.env.LIVE_TRADING_ENABLED = 'true';
    }
    // The chosen broker must still be connected.
    await BrokerConnection.updateOne(
      { userId: account.userId, provider: 'dhan' },
      { expiresAt: new Date(0) },
    );
    const disconnected = await place(account, plan);
    expect(disconnected.status).toBe(409);
    expect(disconnected.body.error).toMatch(/Connect your Dhan account/);
    expect(dhan.placeLimitOrder).not.toHaveBeenCalled();
  });

  it('settles an order the broker rejected after accepting it', async () => {
    const account = await dhanTrader();
    const plan = await syncedPlan(account);
    expect((await place(account, plan)).status).toBe(201);
    dhan.readOrder.mockResolvedValue({
      status: 'rejected',
      filledQuantity: 0,
      averagePrice: 0,
      message: 'Insufficient margin',
    });
    // The next order request re-reads today's placed orders first, so the plan can go again.
    const again = await place(account, plan);
    expect(again.status).toBe(201);
    expect(dhan.readOrder).toHaveBeenCalledWith(account.userId, 'DHAN-1');
    const rejected = await LiveOrder.findOne({ userId: account.userId, status: 'rejected' }).lean();
    expect(rejected).toMatchObject({
      provider: 'dhan',
      error: 'Dhan rejected the order: Insufficient margin',
    });
  });

  it('places the stop-loss and target with the order broker, by hand and automatically', async () => {
    const account = await dhanTrader();
    const plan = await syncedPlan(account, { product: 'CNC', takeProfit: '110' });
    const order = (await place(account, plan)).body.order;
    dhan.readOrder.mockResolvedValue({
      status: 'complete',
      filledQuantity: order.quantity,
      averagePrice: 100,
      message: null,
    });
    const gtt = await account.send('post', `/api/live-orders/${order.id}/gtt`, {
      confirmSymbol: 'RELIANCE',
    });
    expect(gtt.status).toBe(200);
    expect(gtt.body.order.gtt).toMatchObject({ status: 'placed', triggerId: 'OCO-1', stop: 95 });
    expect(dhan.placeStopTarget).toHaveBeenCalledWith(account.userId, {
      symbol: 'RELIANCE',
      exchange: 'NSE',
      quantity: order.quantity,
      stopLoss: 95,
      target: 110,
      lastPrice: 100.2,
    });
    expect(kite.gtt).not.toHaveBeenCalled();

    const auto = await syncedPlan(account, { product: 'CNC', takeProfit: '110', symbol: 'INFY' });
    expect((await place(account, auto, { autoStopTarget: true })).status).toBe(201);
    expect(await placePendingAutoGtts()).toMatchObject({ placed: 1 });
    expect(dhan.placeStopTarget).toHaveBeenCalledTimes(2);
    expect(telegram.sent.at(-1).text).toMatch(/placed on Dhan for INFY/);
  });

  it('offers no stop-loss and target when the adapter cannot place one', async () => {
    dhan = fakeDhan({ capabilities: { portfolio: true, balance: true, orders: true } });
    setBrokerAdapterForTests('dhan', dhan);
    const account = await dhanTrader();
    const plan = await syncedPlan(account, { product: 'CNC', takeProfit: '110' });
    const auto = await place(account, plan, { autoStopTarget: true });
    expect(auto.status).toBe(400);
    expect(auto.body.error).toMatch(/not available with Dhan/);
    const order = (await place(account, plan)).body.order;
    const gtt = await account.send('post', `/api/live-orders/${order.id}/gtt`, {
      confirmSymbol: 'RELIANCE',
    });
    expect(gtt.status).toBe(409);
    expect(dhan.readOrder).not.toHaveBeenCalled();
  });

  it('lets the member choose only a connected broker that takes orders', async () => {
    setBrokerAdapterForTests(
      'dhan',
      fakeDhan({ capabilities: { portfolio: true, balance: true, orders: false } }),
    );
    const account = await member({ brokers: ['kite', 'dhan'], mfa: true, optIn: true });
    const choose = (broker) => account.send('put', '/api/account/live-order-broker', { broker });
    const noOrders = await choose('dhan');
    expect(noOrders.status).toBe(400);
    expect(noOrders.body.error).toMatch(/connected broker that supports live orders/);
    expect((await choose('upstox')).status).toBe(400);
    expect((await choose('nse')).status).toBe(400);
    setBrokerAdapterForTests('dhan', fakeDhan());
    await BrokerConnection.deleteOne({ userId: account.userId, provider: 'dhan' });
    expect((await choose('dhan')).status).toBe(400);
    const state = (await account.agent.get('/api/live-orders')).body.state;
    expect(state).toMatchObject({ enabled: true, broker: { provider: 'kite' } });
  });
});
