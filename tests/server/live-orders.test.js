// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const broker = vi.hoisted(() => ({
  place: vi.fn(),
  quote: vi.fn(),
  gtt: vi.fn(),
  read: vi.fn(),
  market: { status: 'open' },
}));
vi.mock('../../services/market/kite.js', async (original) => ({
  ...(await original()),
  placeKiteLimitOrder: broker.place,
  placeKiteGtt: broker.gtt,
  readKiteOrder: broker.read,
}));
vi.mock('../../services/market/index.js', async (original) => ({
  ...(await original()),
  getQuote: broker.quote,
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
  getMarketStatus: () => broker.market.status,
}));

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const { exportOrderPlanRecords, saveOrderPlan, setOrderPlanReviewed } =
  await import('../../shared/order-plans.js');
const { calculateRiskPlan } = await import('../../shared/risk-calculator.js');
const { DEFAULT_CHARGES } = await import('../../shared/types.js');
const { currentStep, totpCode } = await import('../../services/auth/totp.js');
const { placePendingAutoGtts } = await import('../../services/broker/live-orders.js');

let app;
beforeAll(async () => {
  Object.assign(process.env, {
    KITE_API_KEY: 'test-key',
    KITE_API_SECRET: 'test-secret',
    KITE_REDIRECT_URI: 'http://localhost:3000/api/kite/callback',
    BROKER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    LIVE_TRADING_ENABLED: 'true',
    LIVE_ORDER_MAX_VALUE: '50000',
  });
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of [
    'KITE_API_KEY',
    'KITE_API_SECRET',
    'KITE_REDIRECT_URI',
    'BROKER_TOKEN_ENCRYPTION_KEY',
    'LIVE_TRADING_ENABLED',
    'LIVE_ORDER_MAX_VALUE',
  ])
    delete process.env[key];
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  broker.place.mockReset().mockResolvedValue({ orderId: '250101000000001' });
  broker.quote.mockReset().mockResolvedValue({ price: 100.2 });
  broker.gtt.mockReset().mockResolvedValue({ triggerId: '123456' });
  broker.read.mockReset().mockResolvedValue({
    status: 'COMPLETE',
    quantity: 1,
    filledQuantity: 1,
    averagePrice: 100,
  });
  broker.market.status = 'open';
  telegram.sent = [];
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

async function trader({ mfa = true, optIn = true } = {}) {
  const created = await createMember({ email: 'trader@example.com' });
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
  if (optIn) {
    const opt = await send('put', '/api/account/live-trading', { enabled: true });
    expect(opt.status).toBe(200);
  }
  return { ...session, send, userId: created.user._id };
}

/** Save a plan (₹100 entry) and optionally mark it reviewed, then sync both records. */
async function syncedPlan(
  account,
  { reviewed = true, entryPrice = '100', product = 'MIS', takeProfit = '' } = {},
) {
  const inputs = {
    direction: 'Long',
    accountSize: '100000',
    availableCapital: '20000',
    riskPercent: '1',
    entryPrice,
    stopLoss: String(Number(entryPrice) * 0.95),
    takeProfit,
    product,
    marginPercent: '100',
    // Delivery plans need an explicit charge estimate.
    ...(product === 'CNC' ? { estimatedRoundTripCharges: '40' } : {}),
  };
  const result = calculateRiskPlan(inputs, DEFAULT_CHARGES);
  const plan = saveOrderPlan(account.userId, {
    symbol: 'RELIANCE',
    direction: 'Long',
    product,
    inputs,
    estimate: result.plan,
    chargesSnapshot: { ...DEFAULT_CHARGES },
    strategySnapshot: null,
    rulesSnapshot: [],
    quoteSnapshot: null,
  });
  if (reviewed) setOrderPlanReviewed(account.userId, plan.id, true);
  for (const record of exportOrderPlanRecords(account.userId)) {
    const response = await account.send('post', '/api/order-plans', record);
    expect(response.status).toBeLessThan(300);
  }
  return plan;
}

const place = (account, plan, overrides = {}) =>
  account.send('post', '/api/live-orders', {
    planId: plan.id,
    confirmSymbol: 'RELIANCE',
    idempotencyKey: randomUUID(),
    ...overrides,
  });

describe('live orders', () => {
  it('places one LIMIT order from a reviewed plan, at the plan price', async () => {
    const account = await trader();
    const plan = await syncedPlan(account);
    const response = await place(account, plan);
    expect(response.status).toBe(201);
    expect(response.body.order).toMatchObject({
      status: 'placed',
      side: 'BUY',
      price: '100',
      brokerOrderId: '250101000000001',
    });
    expect(broker.place).toHaveBeenCalledOnce();
    expect(broker.place.mock.calls[0][1]).toMatchObject({
      symbol: 'RELIANCE',
      side: 'BUY',
      product: 'MIS',
      price: '100',
      quantity: plan.estimate.quantity,
    });

    const again = await place(account, plan);
    expect(again.status).toBe(409);
    expect(broker.place).toHaveBeenCalledOnce();
  });

  it('stops live orders for the day once the daily loss limit is reached', async () => {
    const { Trade } = await import('../../models/index.js');
    const { todayInIst } = await import('../../shared/market.js');
    const account = await trader();
    const invalid = await account.send('put', '/api/settings', {
      riskLimits: { dailyLossLimit: '-1' },
    });
    expect(invalid.status).toBe(400);
    const saved = await account.send('put', '/api/settings', {
      riskLimits: { dailyLossLimit: '2000', maxTradesPerDay: '', monthlyProfitGoal: '50000' },
    });
    expect(saved.body.settings.riskLimits).toEqual({
      dailyLossLimit: 2000,
      maxTradesPerDay: null,
      monthlyProfitGoal: 50000,
    });
    await Trade.create({
      _id: randomUUID(),
      userId: account.userId,
      tradeDate: todayInIst(),
      symbol: 'INFY',
      direction: 'Long',
      entryPrice: 100,
      exitPrice: 90,
      quantity: 250,
      grossPnl: -2500,
      charges: 0,
    });
    const state = (await account.agent.get('/api/live-orders')).body.state;
    expect(state.risk).toMatchObject({ blocked: true, dailyLossHit: true, todayPnl: -2500 });
    const plan = await syncedPlan(account);
    const refused = await place(account, plan);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Daily loss limit reached/);
    expect(broker.place).not.toHaveBeenCalled();
  });

  it('returns the same order when a request is retried with its key', async () => {
    const account = await trader();
    const plan = await syncedPlan(account);
    const idempotencyKey = randomUUID();
    const first = await place(account, plan, { idempotencyKey });
    const retry = await place(account, plan, { idempotencyKey });
    expect(retry.body.order.id).toBe(first.body.order.id);
    expect(broker.place).toHaveBeenCalledOnce();
  });

  it('refuses without the server switch, the member opt-in or a verified authenticator', async () => {
    const noMfa = await trader({ mfa: false, optIn: false });
    const denied = await noMfa.send('put', '/api/account/live-trading', { enabled: true });
    expect(denied.status).toBe(403);
    const plan = await syncedPlan(noMfa);
    expect((await place(noMfa, plan)).status).toBe(403);

    process.env.LIVE_TRADING_ENABLED = 'false';
    try {
      const state = (await noMfa.agent.get('/api/live-orders')).body.state;
      expect(state.enabled).toBe(false);
    } finally {
      process.env.LIVE_TRADING_ENABLED = 'true';
    }
    expect(broker.place).not.toHaveBeenCalled();
  });

  it('refuses unreviewed plans, wrong confirmations, closed markets and stale prices', async () => {
    const account = await trader();
    const unreviewed = await syncedPlan(account, { reviewed: false });
    expect((await place(account, unreviewed)).status).toBe(409);

    const plan = await syncedPlan(account);
    expect((await place(account, plan, { confirmSymbol: 'TCS' })).status).toBe(400);

    broker.market.status = 'closed-hours';
    expect((await place(account, plan)).status).toBe(409);
    broker.market.status = 'open';

    broker.quote.mockResolvedValue({ price: 120 });
    const stale = await place(account, plan);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/away from the current price/);
    expect(broker.place).not.toHaveBeenCalled();
  });

  it('enforces the order value limit', async () => {
    const account = await trader();
    process.env.LIVE_ORDER_MAX_VALUE = '1000';
    try {
      const plan = await syncedPlan(account);
      const response = await place(account, plan);
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/exceeds the live order limit/);
    } finally {
      process.env.LIVE_ORDER_MAX_VALUE = '50000';
    }
    expect(broker.place).not.toHaveBeenCalled();
  });

  it('records broker rejections and allows the plan to be sent again', async () => {
    const account = await trader();
    const plan = await syncedPlan(account);
    broker.place.mockRejectedValueOnce(new Error('Zerodha rejected the order: Insufficient funds'));
    const rejected = await place(account, plan);
    expect(rejected.body.order).toMatchObject({
      status: 'rejected',
      error: 'Zerodha rejected the order: Insufficient funds',
    });
    const retried = await place(account, plan);
    expect(retried.body.order.status).toBe('placed');
    const list = (await account.agent.get('/api/live-orders')).body.orders;
    expect(list.map((order) => order.status).sort()).toEqual(['placed', 'rejected']);
  });

  it('marks a lost broker response as unknown and blocks resending', async () => {
    const account = await trader();
    const plan = await syncedPlan(account);
    const lost = Object.assign(new Error('The order outcome is unknown.'), { outcome: 'unknown' });
    broker.place.mockRejectedValueOnce(lost);
    expect((await place(account, plan)).body.order.status).toBe('unknown');
    expect((await place(account, plan)).status).toBe(409);
  });
});

describe('stop-loss and target GTT', () => {
  async function filledCncOrder() {
    const account = await trader();
    const plan = await syncedPlan(account, { product: 'CNC', takeProfit: '110' });
    const placed = await place(account, plan);
    expect(placed.status).toBe(201);
    const order = placed.body.order;
    broker.read.mockResolvedValue({
      status: 'COMPLETE',
      quantity: order.quantity,
      filledQuantity: order.quantity,
      averagePrice: 100,
    });
    return { account, order };
  }
  const gtt = (account, order, confirmSymbol = 'RELIANCE') =>
    account.send('post', `/api/live-orders/${order.id}/gtt`, { confirmSymbol });

  it('places one OCO GTT with the plan stop and target for a filled CNC buy', async () => {
    const { account, order } = await filledCncOrder();
    const response = await gtt(account, order);
    expect(response.status).toBe(200);
    expect(response.body.order.gtt).toMatchObject({
      status: 'placed',
      triggerId: '123456',
      stop: 95,
      target: 110,
    });
    expect(broker.gtt).toHaveBeenCalledWith(
      account.userId,
      expect.objectContaining({
        symbol: 'RELIANCE',
        side: 'SELL',
        product: 'CNC',
        quantity: order.quantity,
        legs: [
          { trigger: 95, price: 94.5 },
          { trigger: 110, price: 110 },
        ],
      }),
    );
    expect((await gtt(account, order)).status).toBe(409);
    expect(broker.gtt).toHaveBeenCalledTimes(1);
  });

  it('refuses until the entry is filled, without the typed symbol, and for MIS', async () => {
    const { account, order } = await filledCncOrder();
    broker.read.mockResolvedValue({
      status: 'OPEN',
      quantity: order.quantity,
      filledQuantity: 0,
      averagePrice: 0,
    });
    const unfilled = await gtt(account, order);
    expect(unfilled.status).toBe(409);
    expect(unfilled.body.error).toMatch(/not completely filled/);
    expect((await gtt(account, order, 'TCS')).status).toBe(400);
    expect(broker.gtt).not.toHaveBeenCalled();

    const intraday = await syncedPlan(account, { entryPrice: '100.1' });
    const mis = (await place(account, intraday)).body.order;
    const refused = await gtt(account, mis);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/CNC/);
  });
});

describe('automatic stop-loss and target', () => {
  it('places the GTT once the entry fills, and only once', async () => {
    const account = await trader();
    const plan = await syncedPlan(account, { product: 'CNC', takeProfit: '110' });
    const placed = await place(account, plan, { autoStopTarget: true });
    expect(placed.status).toBe(201);
    const order = placed.body.order;
    expect(order.autoGtt).toBe(true);

    // Still open at the exchange: nothing is sent yet.
    broker.read.mockResolvedValue({ status: 'OPEN', quantity: order.quantity, filledQuantity: 0 });
    expect(await placePendingAutoGtts()).toMatchObject({ checked: 1, waiting: 1, placed: 0 });
    expect(broker.gtt).not.toHaveBeenCalled();
    expect(telegram.sent).toEqual([]);

    broker.read.mockResolvedValue({
      status: 'COMPLETE',
      quantity: order.quantity,
      filledQuantity: order.quantity,
      averagePrice: 100,
    });
    expect(await placePendingAutoGtts()).toMatchObject({ placed: 1 });
    expect(broker.gtt).toHaveBeenCalledWith(
      account.userId,
      expect.objectContaining({
        side: 'SELL',
        product: 'CNC',
        quantity: order.quantity,
        legs: [
          { trigger: 95, price: 94.5 },
          { trigger: 110, price: 110 },
        ],
      }),
    );
    expect(telegram.sent.at(-1).text).toMatch(/Stop-loss ₹95 and target ₹110 placed/);
    const listed = (await account.agent.get('/api/live-orders')).body.orders[0];
    expect(listed.gtt).toMatchObject({ status: 'placed', triggerId: '123456' });

    expect(await placePendingAutoGtts()).toMatchObject({ checked: 0 });
    expect(broker.gtt).toHaveBeenCalledOnce();
  });

  it('warns on Telegram when the entry was cancelled unfilled', async () => {
    const account = await trader();
    const plan = await syncedPlan(account, { product: 'CNC' });
    await place(account, plan, { autoStopTarget: true });
    broker.read.mockResolvedValue({ status: 'CANCELLED', quantity: 1, filledQuantity: 0 });
    expect(await placePendingAutoGtts()).toMatchObject({ failed: 1 });
    expect(broker.gtt).not.toHaveBeenCalled();
    expect(telegram.sent.at(-1).text).toMatch(
      /NOT placed: The entry order is not completely filled/,
    );
    const listed = (await account.agent.get('/api/live-orders')).body.orders[0];
    expect(listed.gtt).toMatchObject({ status: 'rejected' });
    expect(await placePendingAutoGtts()).toMatchObject({ checked: 0 });
  });

  it('is offered for delivery buys only', async () => {
    const account = await trader();
    const plan = await syncedPlan(account);
    const refused = await place(account, plan, { autoStopTarget: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/delivery \(CNC\) buys only/);
    expect(broker.place).not.toHaveBeenCalled();
  });
});

describe('price ticks', () => {
  it('rounds to ₹0.05 without losing a tick to floating point', async () => {
    const { toTick } = await import('../../services/broker/live-orders.js');
    expect(toTick(100.05, false)).toBe(100.05);
    expect(toTick(1.15, false)).toBe(1.15);
    expect(toTick(0.3, false)).toBe(0.3);
    expect(toTick(99.93, false)).toBe(99.9);
    expect(toTick(99.93, true)).toBe(99.95);
    expect(toTick(1393.035, false)).toBe(1393);
  });
});
