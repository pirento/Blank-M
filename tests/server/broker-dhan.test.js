// @vitest-environment node
// The Dhan adapter against a fake Dhan whose replies are shaped like the examples in
// https://dhanhq.co/docs/v2/ (orders, portfolio, funds, profile and the scrip master).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase, startTestApp, stopTestApp } from '../helpers/app.js';
import { BrokerConnection, BrokerInstrument } from '../../models/index.js';
import { saveBrokerToken } from '../../services/broker/broker-api.js';
import { brokerAdapter } from '../../services/broker/adapters/index.js';
import { readBalance, readBrokerPortfolio } from '../../services/broker/portfolio.js';

const USER = 'dhan-member';
const CLIENT = '1100003626';
const TOKEN = `eyJhbGciOiJIUzUxMiJ9.${'a'.repeat(40)}.signature`;
const realFetch = globalThis.fetch;
const istNow = () =>
  new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const utc = (ist) => new Date(`${ist.replace(' ', 'T')}+05:30`).toISOString();

const SCRIP_MASTER = [
  'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME',
  'BSE,E,500325,EQUITY,0,RELIANCE,1.0,Reliance Industries,,,,10.0000,NA,ES,A,RELIANCE INDUSTRIES LTD',
  'NSE,E,2885,EQUITY,0,RELIANCE,1.0,Reliance Industries,,,,10.0000,NA,ES,EQ,RELIANCE INDUSTRIES LTD',
  'NSE,E,25510,EQUITY,0,MOTHERSON,1.0,SMIL-6.5%-20092027-NCD,,,,5.0000,NA,DEB,D1,SAMVARDHANA MOTHERSON INT',
  'NSE,E,4204,EQUITY,0,MOTHERSON,1.0,Samvardhana Motherson International,,,,1.0000,NA,ES,EQ,SAMVRDHNA MTHRSN INTL LTD',
  'NSE,E,9001,EQUITY,0,TWICE,1.0,Twice A,,,,5.0000,NA,ES,EQ,TWICE A',
  'NSE,E,9002,EQUITY,0,TWICE,1.0,Twice B,,,,5.0000,NA,ES,BE,TWICE B',
  'NSE,D,35000,FUTSTK,0,RELIANCE-Oct2026-FUT,500.0,RELIANCE OCT FUT,2026-10-27 14:30:00,-0.01000,XX,10.0000,M,FUTSTK,,RELIANCE',
].join('\r\n');

/** GET /orders/{order-id} example; also the order book row. */
const order = (overrides = {}) => ({
  dhanClientId: '1000000003',
  orderId: '112111182198',
  correlationId: '123abc678',
  orderStatus: 'PENDING',
  transactionType: 'BUY',
  exchangeSegment: 'NSE_EQ',
  productType: 'INTRADAY',
  orderType: 'MARKET',
  validity: 'DAY',
  tradingSymbol: '',
  securityId: '11536',
  quantity: 5,
  disclosedQuantity: 0,
  price: 0.0,
  triggerPrice: 0.0,
  afterMarketOrder: false,
  boProfitValue: 0.0,
  boStopLossValue: 0.0,
  legName: null,
  createTime: istNow(),
  updateTime: istNow(),
  exchangeTime: istNow(),
  drvExpiryDate: null,
  drvOptionType: null,
  drvStrikePrice: 0.0,
  omsErrorCode: null,
  omsErrorDescription: null,
  algoId: 'string',
  remainingQuantity: 5,
  averageTradedPrice: 0,
  filledQty: 0,
  ...overrides,
});
const position = (overrides = {}) => ({
  dhanClientId: '1000000009',
  tradingSymbol: 'TCS',
  securityId: '11536',
  positionType: 'LONG',
  exchangeSegment: 'NSE_EQ',
  productType: 'CNC',
  buyAvg: 3345.8,
  buyQty: 40,
  costPrice: 3215.0,
  sellAvg: 0.0,
  sellQty: 0,
  netQty: 40,
  realizedProfit: 0.0,
  unrealizedProfit: 6122.0,
  rbiReferenceRate: 1.0,
  multiplier: 1,
  carryForwardBuyQty: 0,
  carryForwardSellQty: 0,
  carryForwardBuyValue: 0.0,
  carryForwardSellValue: 0.0,
  dayBuyQty: 40,
  daySellQty: 0,
  dayBuyValue: 133832.0,
  daySellValue: 0.0,
  drvExpiryDate: '0001-01-01',
  drvOptionType: null,
  drvStrikePrice: 0.0,
  crossCurrency: false,
  ...overrides,
});

let routes;
let calls;
let now;
/** Dhan's API and scrip master; each route returns a fresh Response (or throws). */
function fakeDhan(url, options = {}) {
  const { origin, pathname } = new URL(String(url));
  if (origin === 'https://images.dhan.co') {
    calls.push({ route: 'scrip master' });
    return new Response(SCRIP_MASTER);
  }
  if (origin !== 'https://api.dhan.co') return realFetch(url, options);
  const route = `${options.method ?? 'GET'} ${pathname.replace(/^\/v2/, '')}`;
  calls.push({ route, headers: options.headers, body: options.body && JSON.parse(options.body) });
  if (!routes[route]) throw new Error(`Unexpected Dhan call ${route}`);
  return routes[route]();
}
const routesCalled = () => calls.map((call) => call.route);
const orderPosts = () => calls.filter((call) => call.route === 'POST /orders');

beforeAll(async () => {
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
  await startTestApp();
});
afterAll(stopTestApp);
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeEach(async () => {
  await resetDatabase();
  await saveBrokerToken(USER, 'dhan', 'Dhan', {
    token: TOKEN,
    brokerUserId: CLIENT,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  now = istNow();
  calls = [];
  routes = {
    'GET /profile': () =>
      Response.json({
        dhanClientId: CLIENT,
        tokenValidity: '30/03/2025 15:37',
        activeSegment: 'Equity, Derivative, Currency, Commodity',
        ddpi: 'Active',
        mtf: 'Active',
        dataPlan: 'Active',
        dataValidity: '2024-12-05 09:37:52.0',
      }),
    'GET /holdings': () =>
      Response.json([
        {
          exchange: 'ALL',
          tradingSymbol: 'HDFC',
          securityId: '1330',
          isin: 'INE001A01036',
          totalQty: 1000,
          dpQty: 990,
          t1Qty: 10,
          availableQty: 1000,
          collateralQty: 0,
          avgCostPrice: 2655.0,
        },
      ]),
    'GET /positions': () =>
      Response.json([
        position(),
        position({
          tradingSymbol: 'INFY',
          securityId: '1594',
          positionType: 'SHORT',
          productType: 'INTRADAY',
          buyAvg: 0,
          buyQty: 0,
          sellAvg: 1500,
          sellQty: 10,
          netQty: -10,
          dayBuyQty: 0,
          daySellQty: 10,
          dayBuyValue: 0,
          daySellValue: 15000,
        }),
      ]),
    'GET /orders': () =>
      Response.json([
        order({ createTime: now }),
        order({
          orderId: '112111182199',
          orderStatus: 'CANCELLED',
          tradingSymbol: 'TCS',
          productType: 'CNC',
          orderType: 'LIMIT',
          quantity: 40,
          price: 3345.8,
          filledQty: 10,
          remainingQuantity: 30,
          averageTradedPrice: 3345.8,
          createTime: now,
        }),
        // The docs' own timestamp: another day, dropped by the shared code.
        order({ orderId: '112111182100', createTime: '2021-11-24 13:33:03' }),
      ]),
    'GET /trades': () =>
      Response.json([
        {
          dhanClientId: '1000000009',
          orderId: '112111182045',
          exchangeOrderId: '15112111182045',
          exchangeTradeId: '15112111182045',
          transactionType: 'BUY',
          exchangeSegment: 'NSE_EQ',
          productType: 'INTRADAY',
          orderType: 'LIMIT',
          tradingSymbol: 'TCS',
          securityId: '11536',
          tradedQuantity: 40,
          tradedPrice: 3345.8,
          createTime: now,
          updateTime: now,
          exchangeTime: now,
          drvExpiryDate: null,
          drvOptionType: null,
          drvStrikePrice: 0.0,
        },
      ]),
    'GET /fundlimit': () =>
      Response.json({
        dhanClientId: '1000000009',
        availabelBalance: 98440.0,
        sodLimit: 113642,
        collateralAmount: 0.0,
        receiveableAmount: 0.0,
        utilizedAmount: 15202.0,
        blockedPayoutAmount: 0.0,
        withdrawableBalance: 98310.0,
      }),
    'POST /orders': () => Response.json({ orderId: '112111182198', orderStatus: 'PENDING' }),
    'GET /orders/112111182198': () => Response.json(order()),
  };
  globalThis.fetch = vi.fn(fakeDhan);
});

const adapter = () => brokerAdapter('dhan');
const buy = (overrides = {}) => ({
  symbol: 'RELIANCE',
  exchange: 'NSE',
  side: 'BUY',
  product: 'MIS',
  quantity: 3,
  price: 2450.05,
  tag: 'blank',
  ...overrides,
});

describe('Dhan adapter', () => {
  it('loads through the registry with its capabilities', async () => {
    const dhan = await adapter();
    expect(dhan).toMatchObject({
      provider: 'dhan',
      label: 'Dhan',
      capabilities: { portfolio: true, balance: true, orders: true, stopTarget: false },
    });
    expect(dhan.placeStopTarget).toBeUndefined();
    expect(dhan.configured()).toBe(true);
    const key = process.env.BROKER_TOKEN_ENCRYPTION_KEY;
    delete process.env.BROKER_TOKEN_ENCRYPTION_KEY;
    try {
      expect(dhan.configured()).toBe(false);
    } finally {
      process.env.BROKER_TOKEN_ENCRYPTION_KEY = key;
    }
  });

  it('maps the portfolio and passes the shared checks', async () => {
    const snapshot = await readBrokerPortfolio(USER, async () => undefined, 'dhan');
    expect(routesCalled()[0]).toBe('GET /profile');
    expect(calls.every((call) => call.headers['access-token'] === TOKEN)).toBe(true);
    expect(snapshot.source).toBe('dhan');
    expect(snapshot.holdings).toEqual([
      {
        symbol: 'HDFC',
        exchange: 'ALL',
        isin: 'INE001A01036',
        // Settled and T1 apart, as Zerodha reports them.
        quantity: 990,
        t1Quantity: 10,
        usedQuantity: null,
        averagePrice: 2655,
        lastPrice: 0,
      },
    ]);
    const tcs = { symbol: 'TCS', exchange: 'NSE', product: 'CNC', quantity: 40 };
    const infy = { symbol: 'INFY', exchange: 'NSE', product: 'MIS', quantity: -10 };
    expect(snapshot.positions.net).toEqual([
      { ...tcs, averagePrice: 3345.8, lastPrice: 0 },
      { ...infy, averagePrice: 1500, lastPrice: 0 },
    ]);
    expect(snapshot.positions.day).toEqual(snapshot.positions.net);
    expect(snapshot.orders).toEqual([
      {
        // Dhan's example leaves tradingSymbol empty: the security ID names the instrument.
        symbol: '11536',
        exchange: 'NSE',
        orderId: '112111182198',
        product: 'MIS',
        side: 'BUY',
        status: 'PENDING',
        orderType: 'MARKET',
        quantity: 5,
        filledQuantity: 0,
        pendingQuantity: 5,
        cancelledQuantity: 0,
        price: 0,
        averagePrice: 0,
        placedAt: utc(now),
      },
      expect.objectContaining({
        symbol: 'TCS',
        orderId: '112111182199',
        product: 'CNC',
        status: 'CANCELLED',
        quantity: 40,
        filledQuantity: 10,
        pendingQuantity: 0,
        cancelledQuantity: 30,
        averagePrice: 3345.8,
      }),
    ]);
    expect(snapshot.trades).toEqual([
      {
        symbol: 'TCS',
        exchange: 'NSE',
        tradeId: '15112111182045',
        orderId: '112111182045',
        product: 'MIS',
        side: 'BUY',
        quantity: 40,
        averagePrice: 3345.8,
        filledAt: utc(now),
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
  });

  it('reads an empty demat as no holdings, but never a failed holdings read', async () => {
    routes['GET /holdings'] = () => Response.json({ errorCode: 'DH-1111' }, { status: 500 });
    expect((await readBrokerPortfolio(USER, async () => undefined, 'dhan')).holdings).toEqual([]);
    routes['GET /holdings'] = () => new Response('busy', { status: 503 });
    await expect(readBrokerPortfolio(USER, async () => undefined, 'dhan')).rejects.toMatchObject({
      status: 502,
    });
  });

  it('reads the cash balance', async () => {
    expect(await readBalance(USER, 'dhan')).toMatchObject({
      liveBalance: 98440,
      used: 15202,
      total: null,
      source: 'dhan',
      label: 'Dhan',
    });
    expect(routesCalled()).toEqual(['GET /profile', 'GET /fundlimit']);
  });

  it('reads nothing when the token belongs to another Dhan account', async () => {
    routes['GET /profile'] = () => Response.json({ dhanClientId: '1000000001' });
    await expect(readBalance(USER, 'dhan')).rejects.toMatchObject({ status: 409 });
    expect(routesCalled()).toEqual(['GET /profile']);
  });
});

describe('Dhan live orders', () => {
  it('places one NSE DAY LIMIT order for the linked client', async () => {
    const dhan = await adapter();
    expect(await dhan.placeLimitOrder(USER, buy())).toEqual({ orderId: '112111182198' });
    expect(routesCalled()).toEqual(['scrip master', 'GET /profile', 'POST /orders']);
    const [post] = orderPosts();
    expect(post.headers).toMatchObject({
      'access-token': TOKEN,
      'Content-Type': 'application/json',
    });
    expect(post.body).toEqual({
      dhanClientId: CLIENT,
      correlationId: 'blank',
      transactionType: 'BUY',
      exchangeSegment: 'NSE_EQ',
      productType: 'INTRADAY',
      orderType: 'LIMIT',
      validity: 'DAY',
      securityId: '2885',
      quantity: 3,
      price: 2450.05,
      afterMarketOrder: false,
    });
    await dhan.placeLimitOrder(USER, buy({ product: 'CNC', symbol: 'motherson' }));
    expect(orderPosts()[1].body).toMatchObject({ productType: 'CNC', securityId: '4204' });
  });

  it('keeps an order whose outcome is unknown from being sent again', async () => {
    const dhan = await adapter();
    const failures = [
      () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
      () =>
        Response.json(
          { errorType: 'Internal_Server_Error', errorCode: 'DH-908', errorMessage: 'Error' },
          { status: 500 },
        ),
      () => new Response('<html>Bad gateway</html>', { status: 502 }),
      () => new Response('accepted', { status: 200 }),
      () => Response.json({ orderStatus: 'PENDING' }),
    ];
    for (const failure of failures) {
      routes['POST /orders'] = failure;
      const error = await dhan.placeLimitOrder(USER, buy()).catch((reason) => reason);
      expect(error).toMatchObject({ outcome: 'unknown', status: 504 });
      expect(error.message).toMatch(/Check your Dhan order book/);
    }
    expect(orderPosts()).toHaveLength(failures.length);
  });

  it('treats a readable refusal as rejected', async () => {
    const dhan = await adapter();
    routes['POST /orders'] = () =>
      Response.json(
        { errorType: 'Order_Error', errorCode: 'DH-906', errorMessage: 'Insufficient Funds' },
        { status: 400 },
      );
    const refused = await dhan.placeLimitOrder(USER, buy()).catch((reason) => reason);
    expect(refused).toMatchObject({
      message: 'Dhan rejected the order: DH-906 Insufficient Funds',
    });
    expect(refused.outcome).toBeUndefined();

    routes['POST /orders'] = () => Response.json({ orderId: '1', orderStatus: 'REJECTED' });
    expect((await dhan.placeLimitOrder(USER, buy()).catch((reason) => reason)).outcome).toBe(
      undefined,
    );
    routes['POST /orders'] = () => new Response('{}', { status: 429 });
    await expect(dhan.placeLimitOrder(USER, buy())).rejects.toMatchObject({ status: 429 });

    // A 401 right after the profile accepted the token is about the order (static IP), so the
    // connection is not expired.
    routes['POST /orders'] = () => new Response('{}', { status: 401 });
    const ip = await dhan.placeLimitOrder(USER, buy()).catch((reason) => reason);
    expect(ip.message).toMatch(/static IP/);
    expect(ip.outcome).toBeUndefined();
    const row = await BrokerConnection.findOne({ userId: USER, provider: 'dhan' }).lean();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses what it cannot place and re-verifies the account first', async () => {
    const dhan = await adapter();
    await expect(dhan.placeLimitOrder(USER, buy({ exchange: 'BSE' }))).rejects.toMatchObject({
      status: 400,
    });
    await expect(dhan.placeLimitOrder(USER, buy({ product: 'NRML' }))).rejects.toMatchObject({
      status: 400,
    });
    // Listed twice in the master, so ambiguous; and not an NSE share at all.
    for (const symbol of ['TWICE', 'RELIANCE-OCT2026-FUT']) {
      await expect(dhan.placeLimitOrder(USER, buy({ symbol }))).rejects.toMatchObject({
        status: 400,
        message: `Dhan does not list ${symbol} as an NSE share.`,
      });
    }
    routes['GET /profile'] = () => Response.json({ dhanClientId: '1000000001' });
    await expect(dhan.placeLimitOrder(USER, buy())).rejects.toMatchObject({ status: 409 });
    routes['GET /profile'] = () => new Response('{}', { status: 401 });
    await expect(dhan.placeLimitOrder(USER, buy())).rejects.toMatchObject({ tokenRejected: true });
    expect(orderPosts()).toEqual([]);
    // A token Dhan refuses marks the connection expired, so the member reconnects.
    const row = await BrokerConnection.findOne({ userId: USER, provider: 'dhan' }).lean();
    expect(row.expiresAt.getTime()).toBe(0);
  });
});

describe('Dhan order status', () => {
  it.each([
    ['TRANSIT', 'open'],
    ['PENDING', 'open'],
    ['PART_TRADED', 'open'],
    ['TRADED', 'complete'],
    ['REJECTED', 'rejected'],
    ['CANCELLED', 'cancelled'],
    ['EXPIRED', 'cancelled'],
  ])('maps %s to %s', async (orderStatus, status) => {
    routes['GET /orders/112111182198'] = () =>
      Response.json(
        order({
          orderStatus,
          filledQty: 5,
          averageTradedPrice: 2450.05,
          omsErrorDescription: orderStatus === 'REJECTED' ? 'RMS: Margin exceeds' : null,
        }),
      );
    expect(await (await adapter()).readOrder(USER, '112111182198')).toEqual({
      status,
      filledQuantity: 5,
      averagePrice: 2450.05,
      message: orderStatus === 'REJECTED' ? 'RMS: Margin exceeds' : null,
    });
  });

  it('refuses a bad order ID or an unreadable reply', async () => {
    const dhan = await adapter();
    await expect(dhan.readOrder(USER, '../profile')).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
    routes['GET /orders/112111182198'] = () => Response.json(order({ filledQty: '5' }));
    await expect(dhan.readOrder(USER, '112111182198')).rejects.toMatchObject({ status: 502 });
  });
});

describe('Dhan instrument cache', () => {
  it('keeps only NSE shares from the scrip master and downloads it once', async () => {
    const dhan = await adapter();
    await dhan.placeLimitOrder(USER, buy({ symbol: 'MOTHERSON' }));
    await dhan.placeLimitOrder(USER, buy());
    // The NCD that shares MOTHERSON's symbol, the BSE and F&O rows and the ambiguous TWICE are out.
    expect(orderPosts().map((post) => post.body.securityId)).toEqual(['4204', '2885']);
    expect(routesCalled().filter((route) => route === 'scrip master')).toHaveLength(1);
    const rows = await BrokerInstrument.find({ provider: 'dhan' }).sort({ token: 1 }).lean();
    expect(rows.map((row) => [row.exchange, row.symbol, row.token])).toEqual([
      ['NSE', 'RELIANCE', '2885'],
      ['NSE', 'MOTHERSON', '4204'],
    ]);
  });
});
