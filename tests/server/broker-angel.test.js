// @vitest-environment node
// The Angel One adapter against fetch replies shaped like the examples in SmartAPI's docs
// (smartapi.angelone.in/docs: User, Orders, Portfolio, Postback, Instruments).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase, startTestApp, stopTestApp } from '../helpers/app.js';

const { BrokerConnection, BrokerInstrument } = await import('../../models/index.js');
const { saveBrokerToken } = await import('../../services/broker/broker-api.js');
const { readBalance, readBrokerPortfolio } = await import('../../services/broker/portfolio.js');
const { brokerAdapter } = await import('../../services/broker/adapters/index.js');
const { default: angel, flatJsonObjects } = await import('../../services/broker/adapters/angel.js');

const realFetch = globalThis.fetch;
const USER = 'member-1';
const JWT = 'eyJhbGciOiJIUzUxMiJ9.eyJ1c2VybmFtZSI6IkExMjMifQ.angel-signature';
const API_KEY = 'smartKey01';
const ok = (data) => ({ status: true, message: 'SUCCESS', errorcode: '', data });
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** Now in IST as SmartAPI writes it: "25-Oct-2026 10:15:00". */
function istStamp() {
  const [date, time] = new Date(Date.now() + 330 * 60_000).toISOString().split('T');
  const [year, month, day] = date.split('-');
  return `${day}-${MONTHS[Number(month) - 1]}-${year} ${time.slice(0, 8)}`;
}

// Get Profile, Get Holding, Get Position, Get Order Book (+ the Postback order), Get Trade Book.
const PROFILE = ok({
  clientcode: 'A123456',
  name: 'YOUR_NAME',
  email: '',
  mobileno: '',
  exchanges: ['NSE', 'BSE', 'MCX', 'CDS', 'NCDEX', 'NFO'],
  products: ['DELIVERY', 'INTRADAY', 'MARGIN'],
  lastlogintime: '',
  brokerid: 'B2C',
});
const HOLDING = {
  tradingsymbol: 'TATASTEEL-EQ',
  exchange: 'NSE',
  isin: 'INE081A01020',
  t1quantity: 0,
  realisedquantity: 2,
  quantity: 2,
  authorisedquantity: 0,
  product: 'DELIVERY',
  collateralquantity: null,
  collateraltype: null,
  haircut: 0,
  averageprice: 111.87,
  ltp: 130.15,
  symboltoken: '3499',
  close: 129.6,
  profitandloss: 37,
  pnlpercentage: 16.34,
};
const POSITION = {
  exchange: 'NSE',
  symboltoken: '2885',
  producttype: 'DELIVERY',
  tradingsymbol: 'RELIANCE-EQ',
  symbolname: 'RELIANCE',
  instrumenttype: '',
  priceden: '1',
  pricenum: '1',
  genden: '1',
  gennum: '1',
  precision: '2',
  multiplier: '-1',
  boardlotsize: '1',
  buyqty: '1',
  sellqty: '0',
  buyamount: '2235.80',
  sellamount: '0',
  symbolgroup: 'EQ',
  strikeprice: '-1',
  optiontype: '',
  expirydate: '',
  lotsize: '1',
  cfbuyqty: '0',
  cfsellqty: '0',
  cfbuyamount: '0',
  cfsellamount: '0',
  buyavgprice: '2235.80',
  sellavgprice: '0',
  avgnetprice: '2235.80',
  netvalue: '- 2235.80',
  netqty: '1',
  totalbuyvalue: '2235.80',
  totalsellvalue: '0',
  cfbuyavgprice: '0',
  cfsellavgprice: '0',
  totalbuyavgprice: '2235.80',
  totalsellavgprice: '0',
  netprice: '2235.80',
};
// A short carried in from an earlier day, untouched today: in net, not in day.
const CARRIED = {
  ...POSITION,
  exchange: 'NFO',
  producttype: 'CARRYFORWARD',
  tradingsymbol: 'NIFTY27OCT26FUT',
  symbolgroup: '',
  buyqty: '0',
  buyamount: '0',
  buyavgprice: '0',
  cfsellqty: '75',
  cfsellamount: '1875037.50',
  cfsellavgprice: '25000.50',
  avgnetprice: '25000.50',
  netvalue: '1875037.50',
  netqty: '-75',
  totalbuyvalue: '0',
  totalbuyavgprice: '0',
  totalsellvalue: '1875037.50',
  totalsellavgprice: '25000.50',
  netprice: '25000.50',
};
const CANCELLED_ORDER = {
  variety: 'NORMAL',
  ordertype: 'LIMIT',
  producttype: 'INTRADAY',
  duration: 'DAY',
  price: '194.00',
  triggerprice: '0',
  quantity: '1',
  disclosedquantity: '0',
  squareoff: '0',
  stoploss: '0',
  trailingstoploss: '0',
  tradingsymbol: 'SBIN-EQ',
  transactiontype: 'BUY',
  exchange: 'NSE',
  symboltoken: null,
  instrumenttype: '',
  strikeprice: '-1',
  optiontype: '',
  expirydate: '',
  lotsize: '1',
  cancelsize: '1',
  averageprice: '0',
  filledshares: '0',
  unfilledshares: '1',
  orderid: 201020000000080,
  text: '',
  status: 'cancelled',
  orderstatus: 'cancelled',
  updatetime: '20-Oct-2020 13:10:59',
  exchtime: '20-Oct-2020 13:10:59',
  exchorderupdatetime: '20-Oct-2020 13:10:59',
  fillid: '',
  filltime: '',
  parentorderid: '',
  uniqueorderid: '34reqfachdfih',
  exchangeorderid: '1100000000048358',
};
const OPEN_ORDER = {
  variety: 'NORMAL',
  ordertype: 'MARKET',
  producttype: 'DELIVERY',
  duration: 'DAY',
  price: 0.0,
  triggerprice: 0.0,
  quantity: '1000',
  disclosedquantity: '0',
  squareoff: 0.0,
  stoploss: 0.0,
  trailingstoploss: 0.0,
  tradingsymbol: 'SBIN-EQ',
  transactiontype: 'BUY',
  exchange: 'NSE',
  symboltoken: '3045',
  ordertag: '10007712',
  instrumenttype: '',
  strikeprice: -1.0,
  optiontype: '',
  expirydate: '',
  lotsize: '1',
  cancelsize: '0',
  averageprice: 584.7,
  filledshares: '74',
  unfilledshares: '926',
  orderid: '111111111111111',
  text: '',
  status: 'open',
  orderstatus: 'open',
  updatetime: '09-Oct-2023 18:22:02',
  exchtime: '09-Oct-2023 18:21:12',
  exchorderupdatetime: '09-Oct-2023 18:21:12',
  fillid: '',
  filltime: '',
  parentorderid: '',
  clientcode: 'DUMMY123',
};
const TRADE = {
  exchange: 'NSE',
  producttype: 'DELIVERY',
  tradingsymbol: 'ITC-EQ',
  instrumenttype: '',
  symbolgroup: 'EQ',
  strikeprice: '-1',
  optiontype: '',
  expirydate: '',
  marketlot: '1',
  precision: '2',
  multiplier: '-1',
  tradevalue: '175.00',
  transactiontype: 'BUY',
  fillprice: '175.00',
  fillsize: '1',
  orderid: '201020000000095',
  fillid: '50005750',
  filltime: '13:27:53',
};
// A fill of the open order: its day comes from that order (the trade book gives only a time).
const OPEN_TRADE = {
  ...TRADE,
  tradingsymbol: 'SBIN-EQ',
  fillprice: '584.70',
  fillsize: '74',
  orderid: '111111111111111',
  fillid: '50005751',
  filltime: '10:15:00',
};
// Individual Order Status example.
const DETAILS = {
  variety: 'NORMAL',
  ordertype: 'LIMIT',
  producttype: 'DELIVERY',
  duration: 'DAY',
  price: 2298.25,
  triggerprice: 0,
  quantity: '1',
  disclosedquantity: '0',
  squareoff: 0,
  stoploss: 0,
  trailingstoploss: 0,
  tradingsymbol: 'RELIANCE-EQ',
  transactiontype: 'BUY',
  exchange: 'NSE',
  symboltoken: '2885',
  instrumenttype: '',
  strikeprice: -1,
  optiontype: '',
  expirydate: '',
  lotsize: '1',
  cancelsize: '0',
  averageprice: 0,
  filledshares: '0',
  unfilledshares: '1',
  orderid: '231010000000970',
  text: 'Your order has been rejected due to Insufficient Funds. Available funds - Rs. 937.00 . You require Rs. 2298.25 funds to execute this order.',
  status: 'rejected',
  orderstatus: 'rejected',
  updatetime: '10-Oct-2023 09:00:16',
  exchtime: '',
  exchorderupdatetime: '',
  fillid: '',
  filltime: '',
  parentorderid: '',
  ordertag: '',
  uniqueorderid: '05ebf91b-bea4-4a1d-b0f2-4259606570e3',
};
const RMS = ok({
  net: '9999999999999',
  availablecash: '9999999999999',
  availableintradaypayin: '0',
  availablelimitmargin: '0',
  collateral: '0',
  m2munrealized: '0',
  m2mrealized: '0',
  utiliseddebits: '0',
  utilisedspan: '0',
  utilisedoptionpremium: '0',
  utilisedholdingsales: '0',
  utilisedexposure: '0',
  utilisedturnover: '0',
  utilisedpayout: '0',
});
const PLACED = ok({
  script: 'SBIN-EQ',
  orderid: '200910000000111',
  uniqueorderid: '34reqfachdfih',
});

// Scrip master rows as the live file has them (exch_seg "NSE") and as the docs show them ("nse_cm").
const MASTER = [
  {
    token: '99926000',
    symbol: 'Nifty 50',
    name: 'NIFTY',
    expiry: '',
    strike: '0.000000',
    lotsize: '1',
    instrumenttype: 'AMXIDX',
    exch_seg: 'NSE',
    tick_size: '0.000000',
    freeze_qty: '0',
    is_cas_enabled: false,
  },
  {
    token: '3045',
    symbol: 'SBIN-EQ',
    name: 'SBIN',
    expiry: '',
    strike: '-1.000000',
    lotsize: '1',
    instrumenttype: '',
    exch_seg: 'NSE',
    tick_size: '5.000000',
    freeze_qty: '101538',
    is_cas_enabled: true,
  },
  {
    token: '4884',
    symbol: 'SBIN-BE',
    name: 'SBIN {"₹"}',
    expiry: '',
    strike: '-1.000000',
    lotsize: '1',
    instrumenttype: '',
    exch_seg: 'NSE',
    tick_size: '5.000000',
    is_cas_enabled: true,
  },
  {
    token: '500112',
    symbol: 'SBIN',
    name: 'SBIN',
    expiry: '',
    strike: '-1.000000',
    lotsize: '1',
    instrumenttype: '',
    exch_seg: 'BSE',
    tick_size: '5.000000',
    is_cas_enabled: true,
  },
  {
    token: '2885',
    symbol: 'RELIANCE-EQ',
    name: 'RELIANCE',
    expiry: '',
    strike: '-1.000000',
    lotsize: '1',
    instrumenttype: '',
    exch_seg: 'nse_cm',
    tick_size: '10.000000',
    is_cas_enabled: true,
  },
];
/** The master as a byte stream cut every 7 bytes: inside objects, strings and the "₹". */
function masterBody(text = JSON.stringify(MASTER)) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
      controller.close();
    },
  });
}

let replies;
let calls;
let master;
const angelCalls = () => calls.filter((call) => call.path !== 'master');
beforeAll(async () => {
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  await startTestApp();
});
afterAll(stopTestApp);
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeEach(async () => {
  await resetDatabase();
  calls = [];
  master = () => new Response(masterBody());
  replies = {
    '/user/v1/getProfile': PROFILE,
    '/user/v1/getRMS': RMS,
    '/portfolio/v1/getHolding': ok([HOLDING]),
    '/order/v1/getPosition': ok([POSITION, CARRIED]),
    '/order/v1/getOrderBook': ok([CANCELLED_ORDER, OPEN_ORDER]),
    '/order/v1/getTradeBook': ok([TRADE, OPEN_TRADE]),
    '/order/v1/placeOrder': PLACED,
    [`/order/v1/details/${DETAILS.uniqueorderid}`]: ok(DETAILS),
  };
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const { hostname, pathname } = new URL(url);
    if (hostname === 'margincalculator.angelbroking.com') {
      calls.push({ path: 'master' });
      return master();
    }
    if (hostname !== 'apiconnect.angelone.in') return realFetch(url, options);
    const path = pathname.replace('/rest/secure/angelbroking', '');
    calls.push({ path, options });
    const reply = replies[path];
    return typeof reply === 'function' ? reply() : Response.json(reply);
  });
  await saveBrokerToken(USER, 'angel', 'Angel One', {
    token: JSON.stringify({ apiKey: API_KEY, jwt: JWT }),
    brokerUserId: 'A123456',
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
});

describe('Angel One adapter', () => {
  it('is registered with the contract’s capabilities, without a stop/target', async () => {
    const adapter = await brokerAdapter('angel');
    expect(adapter).toMatchObject({
      provider: 'angel',
      label: 'Angel One',
      capabilities: { portfolio: true, balance: true, orders: true, stopTarget: false },
    });
    expect(adapter.configured()).toBe(true);
  });

  it('maps holdings, positions, orders and trades read after verifying the account', async () => {
    const assertAccess = vi.fn(async () => undefined);
    const portfolio = await angel.readPortfolio(USER, { tradingDate: '2020-10-20', assertAccess });
    expect(portfolio).toEqual({
      holdings: [
        {
          symbol: 'TATASTEEL',
          exchange: 'NSE',
          isin: 'INE081A01020',
          quantity: 2,
          t1Quantity: 0,
          usedQuantity: null,
          averagePrice: 111.87,
          lastPrice: 130.15,
        },
      ],
      positions: {
        net: [
          {
            symbol: 'RELIANCE',
            exchange: 'NSE',
            product: 'CNC',
            quantity: 1,
            averagePrice: 2235.8,
            lastPrice: 0,
          },
          {
            symbol: 'NIFTY26OCTFUT',
            exchange: 'NFO',
            product: 'NRML',
            quantity: -75,
            averagePrice: 25000.5,
            lastPrice: 0,
          },
        ],
        day: [
          {
            symbol: 'RELIANCE',
            exchange: 'NSE',
            product: 'CNC',
            quantity: 1,
            averagePrice: 2235.8,
            lastPrice: 0,
          },
        ],
      },
      orders: [
        {
          symbol: 'SBIN',
          exchange: 'NSE',
          orderId: '201020000000080',
          product: 'MIS',
          side: 'BUY',
          status: 'cancelled',
          orderType: 'LIMIT',
          quantity: 1,
          filledQuantity: 0,
          pendingQuantity: 0,
          cancelledQuantity: 1,
          price: 194,
          averagePrice: 0,
          placedAt: '2020-10-20T07:40:59.000Z',
        },
        {
          symbol: 'SBIN',
          exchange: 'NSE',
          orderId: '111111111111111',
          product: 'CNC',
          side: 'BUY',
          status: 'open',
          orderType: 'MARKET',
          quantity: 1000,
          filledQuantity: 74,
          pendingQuantity: 926,
          cancelledQuantity: 0,
          price: 0,
          averagePrice: 584.7,
          placedAt: '2023-10-09T12:52:02.000Z',
        },
      ],
      trades: [
        {
          symbol: 'ITC',
          exchange: 'NSE',
          tradeId: '50005750',
          orderId: '201020000000095',
          product: 'CNC',
          side: 'BUY',
          quantity: 1,
          averagePrice: 175,
          filledAt: '2020-10-20T07:57:53.000Z',
        },
        {
          symbol: 'SBIN',
          exchange: 'NSE',
          tradeId: '50005751',
          orderId: '111111111111111',
          product: 'CNC',
          side: 'BUY',
          quantity: 74,
          averagePrice: 584.7,
          filledAt: '2023-10-09T04:45:00.000Z',
        },
      ],
    });
    expect(calls.map((call) => call.path)).toEqual([
      '/user/v1/getProfile',
      '/portfolio/v1/getHolding',
      '/order/v1/getPosition',
      '/order/v1/getOrderBook',
      '/order/v1/getTradeBook',
    ]);
    for (const { options } of calls) {
      expect(options.method).toBe('GET');
      expect(options.headers).toMatchObject({
        Authorization: `Bearer ${JWT}`,
        'X-PrivateKey': API_KEY,
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
      });
    }
    expect(assertAccess).toHaveBeenCalledTimes(5);
  });

  it('passes the shared portfolio and balance checks', async () => {
    const now = istStamp();
    replies['/order/v1/getOrderBook'] = ok([
      { ...CANCELLED_ORDER, updatetime: now },
      { ...OPEN_ORDER, updatetime: now },
    ]);
    const snapshot = await readBrokerPortfolio(USER, async () => undefined, 'angel');
    expect(snapshot).toMatchObject({ source: 'angel', currency: 'INR' });
    expect(snapshot.orders.map((order) => order.orderId)).toEqual([
      '201020000000080',
      '111111111111111',
    ]);
    expect(snapshot.trades.map((trade) => trade.tradeId)).toEqual(['50005750', '50005751']);

    expect(await angel.readBalance(USER)).toEqual({ available: 9999999999999 });
    expect(await readBalance(USER, 'angel')).toMatchObject({
      source: 'angel',
      label: 'Angel One',
      liveBalance: 9999999999999,
    });
    replies['/user/v1/getRMS'] = ok({ ...RMS.data, net: '' });
    await expect(readBalance(USER, 'angel')).rejects.toMatchObject({ status: 502 });
  });

  it('reads nothing for another account, and a failed section fails the read', async () => {
    replies['/user/v1/getProfile'] = ok({ ...PROFILE.data, clientcode: 'B999999' });
    await expect(angel.readBalance(USER)).rejects.toMatchObject({ status: 409 });
    expect(calls.map((call) => call.path)).toEqual(['/user/v1/getProfile']);

    replies['/user/v1/getProfile'] = PROFILE;
    replies['/order/v1/getTradeBook'] = {
      status: false,
      message: 'Error',
      errorcode: 'AB2001',
      data: null,
    };
    await expect(readBrokerPortfolio(USER, async () => undefined, 'angel')).rejects.toMatchObject({
      status: 502,
    });
  });

  it('treats SmartAPI’s rate-limit 403 as a rate limit and keeps the connection', async () => {
    const expiresAt = async () =>
      (await BrokerConnection.findOne({ userId: USER, provider: 'angel' }).lean()).expiresAt;
    replies['/user/v1/getProfile'] = () =>
      new Response('Access denied because of exceeding access rate', { status: 403 });
    await expect(angel.readBalance(USER)).rejects.toMatchObject({ status: 429 });
    expect((await expiresAt()).getTime()).toBeGreaterThan(Date.now());

    replies['/user/v1/getProfile'] = () => new Response('Forbidden', { status: 403 });
    await expect(angel.readBalance(USER)).rejects.toMatchObject({ tokenRejected: true });
    expect((await expiresAt()).getTime()).toBe(0);
  });
});

describe('Angel One live orders', () => {
  const order = (overrides = {}) =>
    angel.placeLimitOrder(USER, {
      symbol: 'SBIN',
      exchange: 'NSE',
      side: 'BUY',
      product: 'MIS',
      quantity: 1,
      price: 194.5,
      tag: 'blank',
      ...overrides,
    });
  const placeCalls = () => calls.filter((call) => call.path === '/order/v1/placeOrder');

  it('places one NSE DAY LIMIT order after verifying the account', async () => {
    expect(await order()).toEqual({ orderId: '200910000000111-34reqfachdfih' });
    expect(calls.map((call) => call.path)).toEqual([
      'master',
      '/user/v1/getProfile',
      '/order/v1/placeOrder',
    ]);
    const [placed] = placeCalls();
    expect(placed.options.method).toBe('POST');
    expect(placed.options.headers).toMatchObject({
      Authorization: `Bearer ${JWT}`,
      'Content-Type': 'application/json',
      'X-PrivateKey': API_KEY,
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
    });
    const body = JSON.parse(placed.options.body);
    expect(Object.keys(body).sort()).toEqual(
      [
        'variety',
        'tradingsymbol',
        'symboltoken',
        'transactiontype',
        'exchange',
        'ordertype',
        'producttype',
        'duration',
        'price',
        'quantity',
        'ordertag',
      ].sort(),
    );
    expect(body.variety).toBe('NORMAL');
    expect(body.tradingsymbol).toBe('SBIN-EQ');
    expect(body.symboltoken).toBe('3045');
    expect(body.transactiontype).toBe('BUY');
    expect(body.exchange).toBe('NSE');
    expect(body.ordertype).toBe('LIMIT');
    expect(body.producttype).toBe('INTRADAY');
    expect(body.duration).toBe('DAY');
    expect(body.price).toBe('194.50');
    expect(body.quantity).toBe('1');
    expect(body.ordertag).toBe('blank');

    // Delivery goes as DELIVERY; the cached master is not downloaded again. A numeric orderid
    // (as in the order book example) is read as its digits.
    replies['/order/v1/placeOrder'] = ok({ orderid: 200910000000112, uniqueorderid: 'a-1' });
    expect(
      await order({ product: 'CNC', side: 'SELL', quantity: 3, price: 100, symbol: 'RELIANCE' }),
    ).toEqual({ orderId: '200910000000112-a-1' });
    expect(JSON.parse(placeCalls()[1].options.body)).toMatchObject({
      tradingsymbol: 'RELIANCE-EQ',
      symboltoken: '2885',
      transactiontype: 'SELL',
      producttype: 'DELIVERY',
      price: '100.00',
      quantity: '3',
    });
    expect(calls.filter((call) => call.path === 'master')).toHaveLength(1);
  });

  it('refuses what it cannot place as given, before any order is sent', async () => {
    for (const overrides of [
      { exchange: 'BSE' },
      { product: 'NRML' },
      { side: 'SHORT' },
      { quantity: 0 },
      { quantity: 1.5 },
      { price: 0 },
      { price: 194.555 },
      { symbol: 'NIFTY' }, // not an "-EQ" row
    ]) {
      await expect(order(overrides)).rejects.toMatchObject({ status: 400 });
    }
    replies['/user/v1/getProfile'] = ok({ ...PROFILE.data, clientcode: 'B999999' });
    await expect(order()).rejects.toMatchObject({ status: 409 });
    expect(placeCalls()).toEqual([]);
  });

  it('reports an unknown outcome when the order may have reached Angel One', async () => {
    const unknown = async () => {
      const error = await order().catch((reason) => reason);
      expect(error).toMatchObject({ outcome: 'unknown', status: 504 });
      expect(error.message).toMatch(/Check your Angel One order book/);
    };
    // The request timed out (fetch aborted by its timer).
    replies['/order/v1/placeOrder'] = () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    };
    await unknown();
    replies['/order/v1/placeOrder'] = () =>
      new Response('<html>Bad gateway</html>', { status: 502 });
    await unknown();
    replies['/order/v1/placeOrder'] = () => Response.json({ status: false }, { status: 503 });
    await unknown();
    replies['/order/v1/placeOrder'] = () => new Response('not json');
    await unknown();
    replies['/order/v1/placeOrder'] = ok({ script: 'SBIN-EQ' }); // accepted without an ID
    await unknown();
    replies['/order/v1/placeOrder'] = {};
    await unknown();
    replies['/order/v1/placeOrder'] = {
      status: false,
      message: 'Something Went Wrong, Please Try After Sometime',
      errorcode: 'AB1004',
      data: null,
    };
    await unknown();
    expect(placeCalls()).toHaveLength(7);
  });

  it('reports a refusal with Angel One’s reason and no unknown outcome', async () => {
    replies['/order/v1/placeOrder'] = {
      status: false,
      message: 'Invalid Product Type',
      errorcode: 'AB1012',
      data: null,
    };
    let error = await order().catch((reason) => reason);
    expect(error.outcome).toBeUndefined();
    expect(error.message).toBe('Angel One rejected the order: Invalid Product Type');

    replies['/order/v1/placeOrder'] = () =>
      Response.json(
        { status: false, message: 'Symbol Not Found', errorcode: 'AB1009' },
        { status: 400 },
      );
    error = await order().catch((reason) => reason);
    expect(error.outcome).toBeUndefined();
    expect(error.message).toBe('Angel One rejected the order: Symbol Not Found');

    replies['/order/v1/placeOrder'] = () => new Response('', { status: 429 });
    expect(await order().catch((reason) => reason)).toMatchObject({ status: 429 });

    // getProfile just accepted the session: a 401/403 on the order is a refusal (static IP),
    // and the connection stays linked.
    const before = await BrokerConnection.findOne({ userId: USER, provider: 'angel' }).lean();
    for (const status of [401, 403]) {
      replies['/order/v1/placeOrder'] = () => new Response('', { status });
      error = await order().catch((reason) => reason);
      expect(error).toMatchObject({ status: 403, message: expect.stringMatching(/static IP/) });
      expect(error.tokenRejected).toBeUndefined();
      expect(error.outcome).toBeUndefined();
    }
    const row = await BrokerConnection.findOne({ userId: USER, provider: 'angel' }).lean();
    expect(row.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  });
});

describe('Angel One order status', () => {
  const id = `${DETAILS.orderid}-${DETAILS.uniqueorderid}`;
  const read = (fields) => {
    replies[`/order/v1/details/${DETAILS.uniqueorderid}`] = ok({ ...DETAILS, ...fields });
    return angel.readOrder(USER, id);
  };

  it('reads one order by its unique ID and maps its status', async () => {
    expect(await angel.readOrder(USER, id)).toEqual({
      status: 'rejected',
      filledQuantity: 0,
      averagePrice: 0,
      message: DETAILS.text,
    });
    expect(calls.map((call) => call.path)).toEqual([
      '/order/v1/details/05ebf91b-bea4-4a1d-b0f2-4259606570e3',
    ]);
    for (const status of [
      'open',
      'open pending',
      'trigger pending',
      'modified',
      'modify pending',
      'after market order req received',
      'modify after market order req received',
    ]) {
      expect(await read({ status, text: '' })).toMatchObject({ status: 'open', message: null });
    }
    expect(
      await read({ status: 'open', quantity: '1000', filledshares: '74', averageprice: 584.7 }),
    ).toEqual({ status: 'open', filledQuantity: 74, averagePrice: 584.7, message: null });
    expect(
      await read({ status: 'complete', quantity: '10', filledshares: '10', averageprice: 2298.25 }),
    ).toEqual({ status: 'complete', filledQuantity: 10, averagePrice: 2298.25, message: null });
    // Complete only when completely filled.
    expect(await read({ status: 'complete', quantity: '10', filledshares: '4' })).toMatchObject({
      status: 'open',
    });
    for (const status of ['cancelled', 'cancelled after market order']) {
      expect(await read({ status, text: 'Cancelled by user' })).toMatchObject({
        status: 'cancelled',
        message: 'Cancelled by user',
      });
    }
  });

  it('refuses an unreadable ID or a reply for another order', async () => {
    await expect(angel.readOrder(USER, '231010000000970')).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
    await expect(read({ orderid: '231010000000971' })).rejects.toMatchObject({ status: 502 });
    await expect(read({ filledshares: '' })).rejects.toMatchObject({ status: 502 });
  });
});

describe('Angel One scrip master', () => {
  it('caches only NSE "-EQ" rows, with the tick in rupees', async () => {
    await angel.placeLimitOrder(USER, {
      symbol: 'SBIN',
      exchange: 'NSE',
      side: 'BUY',
      product: 'MIS',
      quantity: 1,
      price: 194.5,
      tag: 'blank',
    });
    const rows = await BrokerInstrument.find(
      { provider: 'angel' },
      { _id: 1, token: 1, lotSize: 1, tickSize: 1 },
    )
      .sort({ _id: 1 })
      .lean();
    expect(rows).toEqual([
      { _id: 'angel:NSE:RELIANCE-EQ', token: '2885', lotSize: 1, tickSize: 0.1 },
      { _id: 'angel:NSE:SBIN-EQ', token: '3045', lotSize: 1, tickSize: 0.05 },
    ]);
  });

  it('parses objects as the bytes arrive, even when split across chunks', async () => {
    const events = [];
    const encode = (text) => new TextEncoder().encode(text);
    async function* chunks() {
      for (const text of ['[{"a":"x}', '"},{"b":', '"₹', '"}]']) {
        events.push(`chunk ${text}`);
        yield encode(text);
      }
    }
    for await (const item of flatJsonObjects(chunks())) events.push(item);
    expect(events).toEqual([
      'chunk [{"a":"x}',
      'chunk "},{"b":',
      { a: 'x}' },
      'chunk "₹',
      'chunk "}]',
      { b: '₹' },
    ]);
    // A multi-byte character split between chunks.
    const rupee = encode('[{"c":"₹"}]');
    const split = [];
    for await (const item of flatJsonObjects([rupee.slice(0, 8), rupee.slice(8)])) split.push(item);
    expect(split).toEqual([{ c: '₹' }]);
  });

  it('fails when the list is cut short, and then places nothing', async () => {
    const all = async (source) => {
      const items = [];
      for await (const item of flatJsonObjects(source)) items.push(item);
      return items;
    };
    const encode = (text) => [new TextEncoder().encode(text)];
    await expect(all(encode('[{"a":1},{"b"'))).rejects.toThrow(/ended early/);
    await expect(all(encode('[{"a":1}'))).rejects.toThrow(/ended early/);
    await expect(all(encode(`[{"a":"${'x'.repeat(70_000)}`))).rejects.toThrow(/too long/);

    master = () => new Response(masterBody(JSON.stringify(MASTER).slice(0, -40)));
    await expect(
      angel.placeLimitOrder(USER, {
        symbol: 'SBIN',
        exchange: 'NSE',
        side: 'BUY',
        product: 'MIS',
        quantity: 1,
        price: 194.5,
        tag: 'blank',
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await BrokerInstrument.countDocuments({ provider: 'angel' })).toBe(0);
    expect(angelCalls()).toEqual([]);
  });
});
