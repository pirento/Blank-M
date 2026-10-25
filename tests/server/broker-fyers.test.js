// @vitest-environment node
// The Fyers broker adapter against a faked Fyers API whose replies are shaped like the examples in
// the official v3 docs (https://fyers.in/api-docs/v3/api/).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { resetDatabase, startTestApp, stopTestApp } = await import('../helpers/app.js');
const { saveBrokerToken } = await import('../../services/broker/broker-api.js');
const { readBrokerPortfolio } = await import('../../services/broker/portfolio.js');
const { brokerAdapter } = await import('../../services/broker/adapters/index.js');
const { BrokerConnection } = await import('../../models/index.js');
const fyers = (await import('../../services/broker/adapters/fyers.js')).default;

const USER = 'member-1';
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const TOKEN = `${base64url({ alg: 'HS256' })}.${base64url({ fy_id: 'XA12345' })}.signature`;
const ENV = {
  BROKER_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
  APP_URL: 'http://blank.test',
  FYERS_APP_ID: 'ABCD1234-100',
  FYERS_SECRET_ID: 'fyers-secret',
};
/** Now in IST as Fyers writes it: "DD-MMM-YYYY hh:mm:ss". */
const istNow = () => {
  const ist = new Date(Date.now() + 330 * 60_000);
  const month = ist.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  return `${String(ist.getUTCDate()).padStart(2, '0')}-${month}-${ist.getUTCFullYear()} ${ist.toISOString().slice(11, 19)}`;
};
const ok = (extra) => ({ s: 'ok', code: 200, message: '', ...extra });

// Get Orders example row.
const orderRow = (extra = {}) => ({
  clientId: 'XA12345',
  exchange: 10,
  fyToken: '101000000014366',
  id: '23080444447604',
  id_fyers: 'c6697c04-d9ab-4a7c-a6f4-b0cc4ca698f6',
  offlineOrder: false,
  source: 'W',
  status: 2,
  type: 1,
  pan: '',
  limitPrice: 8.1,
  productType: 'INTRADAY',
  qty: 1,
  disclosedQty: 0,
  remainingQuantity: 0,
  segment: 10,
  symbol: 'NSE:IDEA-EQ',
  description: 'VODAFONE IDEA LIMITED',
  ex_sym: 'IDEA',
  orderDateTime: istNow(),
  side: 1,
  orderValidity: 'DAY',
  stopPrice: 0,
  tradedPrice: 8.1,
  filledQty: 1,
  exchOrdId: '1100000024706527',
  message: '',
  ch: -0.35,
  chp: -4.24,
  lp: 7.9,
  orderNumStatus: '23080444447604:2',
  slNo: 1,
  orderTag: '1:Ordertag',
  takeProfit: 0,
  stopLoss: 0,
  ...extra,
});
// Get Positions example row (and an NSE equity one in the same shape).
const positionRow = (extra = {}) => ({
  netQty: 1,
  qty: 1,
  avgPrice: 72256.0,
  netAvg: 71856.0,
  side: 1,
  productType: 'MARGIN',
  realized_profit: 400.0,
  unrealized_profit: 461.0,
  pl: 861.0,
  ltp: 72717.0,
  buyQty: 2,
  buyAvg: 72256.0,
  buyVal: 144512.0,
  sellQty: 1,
  sellAvg: 72656.0,
  sellVal: 72656.0,
  slNo: 0,
  fyToken: '1120200831217406',
  crossCurrency: 'N',
  rbiRefRate: 1.0,
  qtyMulti_com: 1.0,
  segment: 20,
  symbol: 'MCX:SILVERMIC20AUGFUT',
  id: 'MCX:SILVERMIC20AUGFUT-MARGIN',
  cfBuyQty: 0,
  cfSellQty: 0,
  dayBuyQty: 0,
  daySellQty: 1,
  exchange: 10,
  ...extra,
});

let api;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  Object.assign(process.env, ENV);
  await startTestApp();
});
afterAll(async () => {
  for (const key of Object.keys(ENV)) delete process.env[key];
  await stopTestApp();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeEach(async () => {
  await resetDatabase();
  await saveBrokerToken(USER, 'fyers', 'Fyers', {
    token: TOKEN,
    brokerUserId: 'XA12345',
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  // Replies by "METHOD /path"; a function reply gets the request options.
  api = {
    calls: [],
    replies: {
      'GET /api/v3/profile': ok({
        data: { fy_id: 'XA12345', name: 'JOHN', display_name: 'JD', totp: true },
      }),
    },
  };
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const { pathname, search } = new URL(url);
    const key = `${options.method ?? 'GET'} ${pathname}`;
    api.calls.push({ key, search, options });
    const reply = api.replies[key];
    if (typeof reply === 'function') return reply(options);
    return reply ? Response.json(reply) : new Response('not found', { status: 404 });
  });
});

const posted = (key) => {
  const call = api.calls.find((item) => item.key === key);
  return call && { ...call, body: JSON.parse(call.options.body) };
};

describe('Fyers adapter', () => {
  it('loads through the registry with every capability', async () => {
    const adapter = await brokerAdapter('fyers');
    expect(adapter).toMatchObject({
      provider: 'fyers',
      label: 'Fyers',
      capabilities: { portfolio: true, balance: true, orders: true, stopTarget: true },
    });
    expect(adapter.configured()).toBe(true);
  });

  it('maps holdings, positions, orders and trades into a valid snapshot', async () => {
    Object.assign(api.replies, {
      'GET /api/v3/holdings': ok({
        overall: { count_total: 1, total_investment: 19.44, total_current_value: 23.7 },
        holdings: [
          {
            costPrice: 6.48,
            id: 0,
            fyToken: '101000000014366',
            symbol: 'NSE:IDEA-EQ',
            isin: 'INE669E01016',
            quantity: 3,
            exchange: 10,
            segment: 10,
            qty_t1: 0,
            remainingQuantity: 2,
            collateralQuantity: 0,
            remainingPledgeQuantity: 3,
            pl: 4.26,
            ltp: 7.9,
            marketVal: 23.700000000000003,
            holdingType: 'HLD',
          },
        ],
      }),
      'GET /api/v3/positions': ok({
        netPositions: [
          positionRow(),
          positionRow({
            symbol: 'NSE:SBIN-EQ',
            id: 'NSE:SBIN-EQ-INTRADAY',
            segment: 10,
            productType: 'INTRADAY',
            netQty: -4,
            qty: 4,
            buyQty: 6,
            buyAvg: 800,
            sellQty: 10,
            sellAvg: 805.5,
            netAvg: 813.75,
            ltp: 801,
            dayBuyQty: 6,
            daySellQty: 10,
          }),
          // Carried in from yesterday and partly sold today.
          positionRow({
            symbol: 'NSE:TCS-EQ',
            id: 'NSE:TCS-EQ-CNC',
            segment: 10,
            productType: 'CNC',
            netQty: 3,
            qty: 3,
            buyQty: 5,
            buyAvg: 3400,
            sellQty: 2,
            sellAvg: 3450,
            ltp: 3440,
            cfBuyQty: 5,
            dayBuyQty: 0,
            daySellQty: 2,
          }),
        ],
      }),
      'GET /api/v3/orders': ok({
        orderBook: [
          orderRow(),
          orderRow({
            id: '23080444447605',
            status: 6,
            qty: 10,
            filledQty: 4,
            remainingQuantity: 6,
            tradedPrice: 8.05,
            side: -1,
            productType: 'CNC',
          }),
          orderRow({
            id: '23080444447606',
            status: 1,
            type: 4,
            qty: 5,
            filledQty: 2,
            remainingQuantity: 0,
          }),
        ],
      }),
      'GET /api/v3/tradebook': ok({
        tradeBook: [
          {
            clientId: 'XA12345',
            orderDateTime: istNow(),
            orderNumber: '120080789075',
            exchangeOrderNo: '1200000009204725',
            exchange: 10,
            side: 1,
            segment: 10,
            orderType: 2,
            fyToken: '101000000010666',
            productType: 'CNC',
            tradedQty: 10,
            tradePrice: 32.7,
            tradeValue: 327.0,
            tradeNumber: '52605023',
            row: 52605023,
            symbol: 'NSE:PNB-EQ',
            orderTag: '1:Ordertag',
          },
        ],
      }),
    });
    const assertAccess = vi.fn(async () => {});
    const snapshot = await readBrokerPortfolio(USER, assertAccess, 'fyers');
    expect(assertAccess.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(snapshot.source).toBe('fyers');
    expect(snapshot.holdings).toEqual([
      {
        symbol: 'IDEA',
        exchange: 'NSE',
        isin: 'INE669E01016',
        quantity: 3,
        t1Quantity: 0,
        usedQuantity: 1,
        averagePrice: 6.48,
        lastPrice: 7.9,
      },
    ]);
    const silver = {
      symbol: 'SILVERMIC20AUGFUT',
      exchange: 'MCX-20',
      product: 'NRML',
      lastPrice: 72717,
    };
    expect(snapshot.positions.net).toEqual([
      // A long's buy average, a short's sell average (never netAvg, which nets booked profit).
      { ...silver, quantity: 1, averagePrice: 72256 },
      {
        symbol: 'SBIN',
        exchange: 'NSE',
        product: 'MIS',
        quantity: -4,
        averagePrice: 805.5,
        lastPrice: 801,
      },
      {
        symbol: 'TCS',
        exchange: 'NSE',
        product: 'CNC',
        quantity: 3,
        averagePrice: 3400,
        lastPrice: 3440,
      },
    ]);
    expect(snapshot.positions.day).toEqual([
      { ...silver, quantity: -1, averagePrice: 72656 },
      {
        symbol: 'SBIN',
        exchange: 'NSE',
        product: 'MIS',
        quantity: -4,
        averagePrice: 805.5,
        lastPrice: 801,
      },
      // With carried quantity Fyers' averages are not today's alone.
      {
        symbol: 'TCS',
        exchange: 'NSE',
        product: 'CNC',
        quantity: -2,
        averagePrice: 0,
        lastPrice: 3440,
      },
    ]);
    const placedAt = snapshot.orders[0].placedAt;
    expect(Date.parse(placedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(snapshot.orders).toEqual([
      {
        symbol: 'IDEA',
        exchange: 'NSE',
        orderId: '23080444447604',
        product: 'MIS',
        side: 'BUY',
        status: 'TRADED',
        orderType: 'LIMIT',
        quantity: 1,
        filledQuantity: 1,
        pendingQuantity: 0,
        cancelledQuantity: 0,
        price: 8.1,
        averagePrice: 8.1,
        placedAt,
      },
      expect.objectContaining({
        orderId: '23080444447605',
        product: 'CNC',
        side: 'SELL',
        status: 'PENDING',
        quantity: 10,
        filledQuantity: 4,
        pendingQuantity: 6,
        cancelledQuantity: 0,
        averagePrice: 8.05,
      }),
      expect.objectContaining({
        orderId: '23080444447606',
        status: 'CANCELLED',
        orderType: 'SL',
        filledQuantity: 2,
        pendingQuantity: 0,
        cancelledQuantity: 3,
      }),
    ]);
    expect(snapshot.trades).toEqual([
      {
        symbol: 'PNB',
        exchange: 'NSE',
        tradeId: '52605023',
        orderId: '120080789075',
        product: 'CNC',
        side: 'BUY',
        quantity: 10,
        averagePrice: 32.7,
        filledAt: expect.stringMatching(/Z$/),
      },
    ]);
    expect(api.calls.every((call) => call.key.startsWith('GET '))).toBe(true);
    expect(api.calls[0].options.headers.Authorization).toBe(`ABCD1234-100:${TOKEN}`);

    // An unreadable time or side rejects the whole read rather than guessing.
    api.replies['GET /api/v3/tradebook'].tradeBook[0].orderDateTime = '2026/10/12 10:15';
    await expect(readBrokerPortfolio(USER, assertAccess, 'fyers')).rejects.toMatchObject({
      status: 502,
    });
  });

  it('reads the equity balance by its titles', async () => {
    api.replies['GET /api/v3/funds'] = ok({
      fund_limit: [
        { id: 1, title: 'Total Balance', equityAmount: 58.150000000000006, commodityAmount: 0 },
        { id: 2, title: 'Utilized Amount', equityAmount: 0.3, commodityAmount: 0 },
        { id: 3, title: 'Clear Balance', equityAmount: 58.150000000000006, commodityAmount: 0 },
        { id: 9, title: 'Limit at start of the day', equityAmount: 58.45, commodityAmount: 0 },
        {
          id: 10,
          title: 'Available Balance',
          equityAmount: 58.150000000000006,
          commodityAmount: 0,
        },
      ],
    });
    expect(await fyers.readBalance(USER)).toEqual({
      available: 58.150000000000006,
      used: 0.3,
      total: 58.150000000000006,
    });
  });

  it('places one NSE DAY LIMIT order after verifying the account', async () => {
    api.replies['POST /api/v3/orders/sync'] = {
      s: 'ok',
      code: 1101,
      message: 'Order submitted successfully. Your Order Ref. No.808058117761',
      id: '808058117761',
    };
    const order = {
      symbol: 'M&M',
      exchange: 'NSE',
      side: 'BUY',
      product: 'MIS',
      quantity: 7,
      price: 2950.05,
      tag: 'blank',
    };
    expect(await fyers.placeLimitOrder(USER, order)).toEqual({ orderId: '808058117761' });
    expect(api.calls.map((call) => call.key)).toEqual([
      'GET /api/v3/profile',
      'POST /api/v3/orders/sync',
    ]);
    const { body, options } = posted('POST /api/v3/orders/sync');
    expect(options.headers).toMatchObject({
      Authorization: `ABCD1234-100:${TOKEN}`,
      'Content-Type': 'application/json',
    });
    expect(body).toEqual({
      symbol: 'NSE:M&M-EQ',
      qty: 7,
      type: 1,
      side: 1,
      productType: 'INTRADAY',
      limitPrice: 2950.05,
      stopPrice: 0,
      validity: 'DAY',
      disclosedQty: 0,
      offlineOrder: false,
      isSliceOrder: false,
      orderTag: 'blank',
    });

    // Delivery sells map to CNC and side -1; a tag Fyers would refuse is left out.
    api.calls = [];
    await fyers.placeLimitOrder(USER, { ...order, side: 'SELL', product: 'CNC', tag: 'Untagged' });
    expect(posted('POST /api/v3/orders/sync').body).toMatchObject({
      side: -1,
      productType: 'CNC',
    });
    expect(posted('POST /api/v3/orders/sync').body).not.toHaveProperty('orderTag');
  });

  it('refuses what it cannot place as given, and another account', async () => {
    const order = { symbol: 'SBIN', exchange: 'NSE', side: 'BUY', product: 'MIS', quantity: 1 };
    for (const bad of [
      { exchange: 'BSE' },
      { product: 'NRML' },
      { symbol: 'NSE:SBIN-EQ' },
      { quantity: 0 },
    ]) {
      await expect(
        fyers.placeLimitOrder(USER, { ...order, price: 800, tag: 'blank', ...bad }),
      ).rejects.toMatchObject({ status: 400 });
    }
    api.replies['GET /api/v3/profile'] = ok({ data: { fy_id: 'XB99999' } });
    await expect(
      fyers.placeLimitOrder(USER, { ...order, price: 800, tag: 'blank' }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/could not be verified/),
    });
    expect(api.calls.some((call) => call.key.startsWith('POST'))).toBe(false);
  });

  it('reports an outcome it cannot know as unknown, and a refusal as rejected', async () => {
    const order = {
      symbol: 'SBIN',
      exchange: 'NSE',
      side: 'BUY',
      product: 'MIS',
      quantity: 1,
      price: 800,
      tag: 'blank',
    };
    const attempt = (reply) => {
      api.replies['POST /api/v3/orders/sync'] = reply;
      return fyers.placeLimitOrder(USER, order).catch((error) => error);
    };
    // A timeout aborts the request.
    const timeout = await attempt(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    expect(timeout).toMatchObject({ outcome: 'unknown', status: 504 });
    expect(timeout.message).toMatch(/Check your Fyers order book/);
    for (const reply of [
      async () => new Response('upstream error', { status: 502 }),
      async () => Response.json({ s: 'error', code: -1, message: 'x' }, { status: 500 }),
      async () => new Response('<html>', { status: 200 }),
      // Code 201: requested but not acknowledged.
      { s: 'ok', code: 201, message: 'Order in transit', id: '808058117762' },
      { s: 'ok', code: 1101, message: 'Order submitted successfully.' },
    ]) {
      expect(await attempt(reply)).toMatchObject({ outcome: 'unknown' });
    }

    const refused = await attempt(async () =>
      Response.json({ s: 'error', code: -50, message: 'Invalid limit price' }, { status: 400 }),
    );
    expect(refused).toMatchObject({
      status: 502,
      message: 'Fyers rejected the order: Invalid limit price',
    });
    expect(refused.outcome).toBeUndefined();
    const rejected = await attempt({ s: 'error', code: -99, message: 'Insufficient funds' });
    expect(rejected.message).toBe('Fyers rejected the order: Insufficient funds');
    expect(rejected.outcome).toBeUndefined();
    expect((await attempt({ s: 'error', code: -429, message: 'Limit' })).status).toBe(429);

    // A token the profile check refuses expires the connection so the member reconnects.
    api.replies['GET /api/v3/profile'] = {
      s: 'error',
      code: -16,
      message: 'Could not authenticate',
    };
    const expired = await attempt({ s: 'ok', code: 1101, id: '1' });
    expect(expired).toMatchObject({ status: 401 });
    expect(expired.outcome).toBeUndefined();
    const row = await BrokerConnection.findOne({ userId: USER, provider: 'fyers' }).lean();
    expect(row.expiresAt.getTime()).toBe(0);
  });

  it('keeps the connection linked when the order or GTT call itself is refused', async () => {
    const order = {
      symbol: 'SBIN',
      exchange: 'NSE',
      side: 'BUY',
      product: 'CNC',
      quantity: 1,
      price: 800,
      tag: 'blank',
    };
    const gtt = { symbol: 'SBIN', exchange: 'NSE', quantity: 1, stopLoss: 760, target: 840 };
    const refusals = [
      async () =>
        Response.json({ s: 'error', code: -16, message: 'IP not allowed' }, { status: 401 }),
      async () => new Response('Forbidden', { status: 403 }),
      // A token code in the body after the profile accepted the same token.
      { s: 'error', code: -16, message: 'Could not authenticate' },
    ];
    for (const reply of refusals) {
      api.replies['POST /api/v3/orders/sync'] = reply;
      api.replies['POST /api/v3/gtt/orders/sync'] = reply;
      for (const [what, send] of [
        ['order', () => fyers.placeLimitOrder(USER, order)],
        ['GTT', () => fyers.placeStopTarget(USER, gtt)],
      ]) {
        const error = await send().catch((caught) => caught);
        expect(error).toMatchObject({
          status: 403,
          message: `Fyers refused the ${what}. Check that this server's static IP is registered in your Fyers account and the app has the Order Placement permission.`,
        });
        expect(error.outcome).toBeUndefined();
        expect(error.tokenRejected).toBeUndefined();
      }
    }
    const row = await BrokerConnection.findOne({ userId: USER, provider: 'fyers' }).lean();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.brokerUserId).toBe('XA12345');
    // Still usable: the next read goes through with the same token.
    api.replies['GET /api/v3/orders'] = ok({ orderBook: [orderRow()] });
    expect((await fyers.readOrder(USER, '23080444447604')).status).toBe('complete');
  });

  it('maps order statuses: complete only when fully filled', async () => {
    const read = async (extra) => {
      api.replies['GET /api/v3/orders'] = ok({ orderBook: [orderRow(extra)] });
      return fyers.readOrder(USER, '23080444447604');
    };
    expect(await read({})).toEqual({
      status: 'complete',
      filledQuantity: 1,
      averagePrice: 8.1,
      message: null,
    });
    expect(api.calls.at(-1).search).toBe('?id=23080444447604');
    const partial = { qty: 10, filledQty: 4, remainingQuantity: 6 };
    expect((await read({ ...partial, status: 6 })).status).toBe('open');
    expect((await read({ ...partial, status: 4 })).status).toBe('open');
    expect((await read({ ...partial, status: 2 })).status).toBe('open');
    expect(await read({ status: 5, filledQty: 0, message: 'RMS: Margin Exceeds' })).toEqual({
      status: 'rejected',
      filledQuantity: 0,
      averagePrice: 8.1,
      message: 'RMS: Margin Exceeds',
    });
    expect((await read({ ...partial, status: 1 })).status).toBe('cancelled');
    expect((await read({ status: 7, filledQty: 0 })).status).toBe('cancelled');
    api.replies['GET /api/v3/orders'] = ok({ orderBook: [] });
    await expect(fyers.readOrder(USER, '23080444447604')).rejects.toMatchObject({ status: 502 });
    await expect(fyers.readOrder(USER, '../funds')).rejects.toMatchObject({ status: 400 });
  });

  it('places the stop-loss and target as one GTT OCO on the tick', async () => {
    api.replies['POST /api/v3/gtt/orders/sync'] = {
      code: 1101,
      message: 'Successfully placed order',
      s: 'ok',
      id: '25012400002100',
    };
    const gtt = { symbol: 'SBIN', exchange: 'NSE', quantity: 3, lastPrice: 800 };
    expect(
      await fyers.placeStopTarget(USER, { ...gtt, stopLoss: 600.03, target: 1000.02 }),
    ).toEqual({ triggerId: '25012400002100' });
    expect(posted('POST /api/v3/gtt/orders/sync').body).toEqual({
      side: -1,
      symbol: 'NSE:SBIN-EQ',
      productType: 'CNC',
      orderInfo: {
        // leg1 triggers above the price (the target, rounded up), leg2 below (the stop, down).
        leg1: { price: 1000.1, triggerPrice: 1000.1, qty: 3 },
        leg2: { price: 597, triggerPrice: 600, qty: 3 },
      },
    });

    api.calls = [];
    await fyers.placeStopTarget(USER, { ...gtt, stopLoss: 600.03, target: null });
    expect(posted('POST /api/v3/gtt/orders/sync').body.orderInfo).toEqual({
      leg1: { price: 597, triggerPrice: 600, qty: 3 },
    });

    api.replies['POST /api/v3/gtt/orders/sync'] = { s: 'ok', code: 201, message: 'In transit' };
    await expect(
      fyers.placeStopTarget(USER, { ...gtt, stopLoss: 600, target: 1000 }),
    ).rejects.toMatchObject({ outcome: 'unknown', message: expect.stringMatching(/GTT orders/) });
  });
});
