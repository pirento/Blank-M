// @vitest-environment node
// The Upstox broker adapter against a mocked Upstox API. Payloads follow the examples in the
// official docs (upstox.com/developer/api-documentation): get-holdings, get-positions,
// get-order-book, get-trade-history, get-user-fund-margin, get-profile, get-order-details,
// v3/place-order, response-structure (errors) and instruments (the JSON master file).
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase, startTestApp, stopTestApp } from '../helpers/app.js';
import { BrokerConnection, BrokerInstrument } from '../../models/index.js';
import { saveBrokerToken } from '../../services/broker/broker-api.js';
import { brokerAdapter } from '../../services/broker/adapters/index.js';
import { readBalance, readBrokerPortfolio } from '../../services/broker/portfolio.js';

const ENV = {
  BROKER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
  APP_URL: 'http://blank.test',
  UPSTOX_API_KEY: 'upstox-key',
  UPSTOX_API_SECRET: 'upstox-secret',
};
const TOKEN = 'upstox-access-token-0123456789abcdef';
const USER = 'member-1';
const ORDER_URL = 'https://api-hft.upstox.com/v3/order/place';
const MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
const realFetch = globalThis.fetch;

// Today in IST, in both Upstox timestamp styles, so the shared code keeps the rows.
const ist = new Date(Date.now() + 330 * 60_000).toISOString();
const [day, time] = [ist.slice(0, 10), ist.slice(11, 19)];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const orderTime = `${day} ${time}`;
const tradeTime = `${day.slice(8)}-${MONTHS[Number(day.slice(5, 7)) - 1]}-${day.slice(0, 4)} ${time}`;
const utc = new Date(`${day}T${time}+05:30`).toISOString();

const holdings = [
  {
    isin: 'INE528G01035',
    cnc_used_quantity: 0,
    collateral_type: 'WC',
    company_name: 'YES BANK LTD.',
    haircut: 0.2,
    product: 'D',
    quantity: 36,
    trading_symbol: 'YESBANK',
    tradingsymbol: 'YESBANK',
    last_price: 17.05,
    close_price: 17.05,
    pnl: -61.2,
    day_change: 0,
    day_change_percentage: 0,
    instrument_token: 'NSE_EQ|INE528G01035',
    average_price: 18.75,
    collateral_quantity: 0,
    collateral_update_quantity: 0,
    t1_quantity: 0,
    exchange: 'NSE',
  },
];
const positions = [
  {
    exchange: 'NFO',
    multiplier: 1.0,
    value: 39.75,
    pnl: 26.25,
    product: 'D',
    instrument_token: 'NSE_FO|52618',
    average_price: 2.65,
    buy_value: 0.0,
    overnight_quantity: 15,
    day_buy_value: 0.0,
    day_buy_price: 0.0,
    overnight_buy_amount: 39.75,
    overnight_buy_quantity: 15,
    day_buy_quantity: 0,
    day_sell_value: 0.0,
    day_sell_price: 0.0,
    overnight_sell_amount: 0.0,
    overnight_sell_quantity: 0,
    day_sell_quantity: 0,
    quantity: 15,
    last_price: 1.75,
    unrealised: -658304.25,
    realised: -0.0,
    sell_value: 0.0,
    trading_symbol: 'BANKNIFTY23OCT38000PE',
    tradingsymbol: 'BANKNIFTY23OCT38000PE',
    close_price: 1.95,
    buy_price: 2.65,
    sell_price: 0.0,
  },
  {
    exchange: 'BSE',
    multiplier: 1.0,
    value: 0.8,
    pnl: 0.01,
    product: 'D',
    instrument_token: 'BSE_EQ|INE220J01025',
    average_price: null,
    buy_value: 0.8,
    overnight_quantity: 0,
    day_buy_value: 0.8,
    day_buy_price: 0.8,
    overnight_buy_amount: 0.0,
    overnight_buy_quantity: 0,
    day_buy_quantity: 1,
    day_sell_value: 0.0,
    day_sell_price: 0.0,
    overnight_sell_amount: 0.0,
    overnight_sell_quantity: 0,
    day_sell_quantity: 0,
    quantity: 1,
    last_price: 0.81,
    unrealised: 0.01,
    realised: -0.0,
    sell_value: 0.0,
    trading_symbol: 'FCONSUMER',
    tradingsymbol: 'FCONSUMER',
    close_price: 0.8,
    buy_price: 0.8,
    sell_price: 0.0,
  },
];
const order = (fields) => ({
  exchange: 'NSE',
  product: 'D',
  price: 571.0,
  quantity: 1,
  status: 'complete',
  guid: null,
  tag: null,
  instrument_token: 'NSE_EQ|INE062A01020',
  placed_by: '******',
  trading_symbol: 'SBIN-EQ',
  tradingsymbol: 'SBIN-EQ',
  order_type: 'LIMIT',
  validity: 'DAY',
  trigger_price: 0,
  disclosed_quantity: 0,
  transaction_type: 'BUY',
  average_price: 570.95,
  filled_quantity: 1,
  pending_quantity: 0,
  status_message: null,
  status_message_raw: null,
  exchange_order_id: '1300000025660919',
  parent_order_id: null,
  order_id: '231019025562880',
  variety: 'SIMPLE',
  order_timestamp: orderTime,
  exchange_timestamp: orderTime,
  is_amo: false,
  order_request_id: '1',
  order_ref_id: 'GTT-C23191000044253',
  ...fields,
});
const orders = [
  order({}),
  order({
    exchange: 'NFO',
    product: 'I',
    price: 0,
    quantity: 1500,
    status: 'rejected',
    instrument_token: 'NSE_FO|52567',
    trading_symbol: 'SBIN23OCTFUT',
    tradingsymbol: 'SBIN23OCTFUT',
    order_type: 'SL-M',
    trigger_price: 570,
    transaction_type: 'SELL',
    average_price: 0,
    filled_quantity: 0,
    pending_quantity: 0,
    status_message: 'You need to add Rs. 138385.27 in your account to place this trade.',
    exchange_order_id: '',
    order_id: '231019025000398',
    exchange_timestamp: null,
  }),
  order({
    exchange: 'BFO',
    price: 0.05,
    quantity: 10,
    status: 'cancelled',
    instrument_token: 'BSE_FO|822663',
    trading_symbol: 'SENSEX23O2066000PE',
    tradingsymbol: 'SENSEX23O2066000PE',
    average_price: 0,
    filled_quantity: 0,
    pending_quantity: 10,
    order_id: '231019025000428',
  }),
];
const trades = [
  {
    exchange: 'NSE',
    product: 'D',
    trading_symbol: 'GMRINFRA-EQ',
    tradingsymbol: 'GMRINFRA-EQ',
    instrument_token: '151064324',
    order_type: 'MARKET',
    transaction_type: 'BUY',
    quantity: 1,
    exchange_order_id: '221013001021540',
    order_id: '221013001021539',
    exchange_timestamp: tradeTime,
    average_price: 299.4,
    trade_id: '50091502',
    order_ref_id: 'udapi-aqwsed14356',
    order_timestamp: tradeTime,
  },
];
const funds = {
  equity: {
    used_margin: 0.8,
    payin_amount: 200.0,
    span_margin: 0.0,
    adhoc_margin: 0.0,
    notional_cash: 0.0,
    available_margin: 15507.46,
    exposure_margin: 0.0,
  },
  commodity: {
    used_margin: 0,
    payin_amount: 0,
    span_margin: 0,
    adhoc_margin: 0,
    notional_cash: 0,
    available_margin: 0,
    exposure_margin: 0,
  },
};
const profile = (userId) => ({
  email: '******',
  exchanges: ['NSE', 'NFO', 'BSE', 'CDS', 'BFO', 'BCD'],
  products: ['D', 'CO', 'I'],
  broker: 'UPSTOX',
  user_id: userId,
  user_name: '******',
  order_types: ['MARKET', 'LIMIT', 'SL', 'SL-M'],
  user_type: 'individual',
  poa: false,
  ddpi: false,
  is_active: true,
});
const equity = (symbol, isin, extra = {}) => ({
  segment: 'NSE_EQ',
  name: `${symbol} LIMITED`,
  exchange: 'NSE',
  isin,
  instrument_type: 'EQ',
  instrument_key: `NSE_EQ|${isin}`,
  lot_size: 1,
  freeze_quantity: 100000.0,
  exchange_token: '2885',
  tick_size: 10.0,
  trading_symbol: symbol,
  short_name: symbol,
  security_type: 'NORMAL',
  cas_eligible: true,
  ...extra,
});
/** A small master: two cash equities among rows the adapter must skip. */
const MASTER = [
  equity('RELIANCE', 'INE002A01018'),
  equity('JOCIL', 'INE839G01010', { instrument_type: 'BE', name: 'BE series {T2T} "quoted"' }),
  {
    weekly: false,
    segment: 'NSE_FO',
    name: 'RELIANCE INDUSTRIES LTD',
    exchange: 'NSE',
    expiry: 1706207399000,
    instrument_type: 'FUT',
    underlying_symbol: 'RELIANCE',
    instrument_key: 'NSE_FO|36702',
    lot_size: 250,
    freeze_quantity: 100000.0,
    exchange_token: '36702',
    minimum_lot: 250,
    underlying_key: 'NSE_EQ|INE002A01018',
    tick_size: 5.0,
    underlying_type: 'EQUITY',
    trading_symbol: 'RELIANCE FUT 27 NOV 26',
    strike_price: 0.0,
  },
  {
    segment: 'NSE_INDEX',
    name: 'Nifty 50',
    exchange: 'NSE',
    instrument_type: 'INDEX',
    instrument_key: 'NSE_INDEX|Nifty 50',
    exchange_token: '26000',
    trading_symbol: 'NIFTY',
  },
  equity('M&M', 'INE101A01026', { name: 'MAHINDRA & MAHINDRA LTD \\ {x}' }),
];
/** The gzipped master as a body that arrives in small pieces, as a real download does. */
function masterBody() {
  const bytes = gzipSync(JSON.stringify(MASTER));
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 64) controller.enqueue(bytes.subarray(at, at + 64));
      controller.close();
    },
  });
}

let upstox;
let adapter;
beforeAll(async () => {
  Object.assign(process.env, ENV);
  await startTestApp();
  adapter = await brokerAdapter('upstox');
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
  upstox = {
    calls: [],
    userId: 'UPX123',
    details: order({}),
    place: () =>
      Response.json({
        status: 'success',
        data: { order_ids: ['1644490272000'] },
        metadata: { latency: 30 },
      }),
  };
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const { origin, pathname } = new URL(url);
    if (!origin.endsWith('upstox.com')) return realFetch(url, options);
    upstox.calls.push({ url: String(url), options });
    if (url === MASTER_URL) return new Response(masterBody());
    if (url === ORDER_URL) return upstox.place(options);
    const data = {
      '/v2/user/profile': profile(upstox.userId),
      '/v2/portfolio/long-term-holdings': holdings,
      '/v2/portfolio/short-term-positions': positions,
      '/v2/order/retrieve-all': orders,
      '/v2/order/trades/get-trades-for-day': trades,
      '/v2/user/get-funds-and-margin': funds,
      '/v2/order/details': upstox.details,
    }[pathname];
    return data ? Response.json({ status: 'success', data }) : new Response('{}', { status: 404 });
  });
  await saveBrokerToken(USER, 'upstox', 'Upstox', {
    token: TOKEN,
    brokerUserId: 'UPX123',
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
});

const paths = () => upstox.calls.map((call) => new URL(call.url).pathname);
const place = (overrides = {}) =>
  adapter.placeLimitOrder(USER, {
    symbol: 'RELIANCE',
    exchange: 'NSE',
    side: 'BUY',
    product: 'CNC',
    quantity: 3,
    price: 2450.5,
    tag: 'blank',
    ...overrides,
  });

describe('Upstox adapter', () => {
  it('loads through the registry with its capabilities', () => {
    expect(adapter).toMatchObject({
      provider: 'upstox',
      label: 'Upstox',
      capabilities: { portfolio: true, balance: true, orders: true, stopTarget: false },
    });
    expect(adapter.configured()).toBe(true);
  });

  it('maps the portfolio and passes the shared checks', async () => {
    const snapshot = await readBrokerPortfolio(USER, async () => {}, 'upstox');
    expect(paths()[0]).toBe('/v2/user/profile');
    expect(
      upstox.calls.every((call) => call.options.headers.Authorization === `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    expect(snapshot.holdings).toEqual([
      {
        symbol: 'YESBANK',
        exchange: 'NSE',
        isin: 'INE528G01035',
        quantity: 36,
        t1Quantity: 0,
        usedQuantity: 0,
        averagePrice: 18.75,
        lastPrice: 17.05,
      },
    ]);
    expect(snapshot.positions).toEqual({
      net: [
        {
          symbol: 'BANKNIFTY23OCT38000PE',
          exchange: 'NFO',
          product: 'NRML',
          quantity: 15,
          averagePrice: 2.65,
          lastPrice: 1.75,
        },
        {
          symbol: 'FCONSUMER',
          exchange: 'BSE',
          product: 'CNC',
          quantity: 1,
          averagePrice: 0,
          lastPrice: 0.81,
        },
      ],
      // Only today's buy of FCONSUMER; the option was carried in.
      day: [
        {
          symbol: 'FCONSUMER',
          exchange: 'BSE',
          product: 'CNC',
          quantity: 1,
          averagePrice: 0.8,
          lastPrice: 0.81,
        },
      ],
    });
    expect(snapshot.orders).toEqual([
      {
        symbol: 'SBIN',
        exchange: 'NSE',
        orderId: '231019025562880',
        product: 'CNC',
        side: 'BUY',
        status: 'complete',
        orderType: 'LIMIT',
        quantity: 1,
        filledQuantity: 1,
        pendingQuantity: 0,
        cancelledQuantity: 0,
        price: 571,
        averagePrice: 570.95,
        placedAt: utc,
      },
      expect.objectContaining({
        symbol: 'SBIN23OCTFUT',
        exchange: 'NFO',
        product: 'MIS',
        side: 'SELL',
        status: 'rejected',
        orderType: 'SL-M',
        pendingQuantity: 0,
        cancelledQuantity: 0,
      }),
      // Upstox still shows the 10 unfilled as pending; they were cancelled.
      expect.objectContaining({
        orderId: '231019025000428',
        product: 'NRML',
        status: 'cancelled',
        quantity: 10,
        filledQuantity: 0,
        pendingQuantity: 0,
        cancelledQuantity: 10,
      }),
    ]);
    expect(snapshot.trades).toEqual([
      {
        symbol: 'GMRINFRA',
        exchange: 'NSE',
        tradeId: '50091502',
        orderId: '221013001021539',
        product: 'CNC',
        side: 'BUY',
        quantity: 1,
        averagePrice: 299.4,
        filledAt: utc,
      },
    ]);
  });

  it('rejects an unreadable timestamp instead of guessing it', async () => {
    orders[0].order_timestamp = 'yesterday';
    try {
      await expect(readBrokerPortfolio(USER, async () => {}, 'upstox')).rejects.toMatchObject({
        status: 502,
      });
    } finally {
      orders[0].order_timestamp = orderTime;
    }
  });

  it('reads the equity balance', async () => {
    expect(await readBalance(USER, 'upstox')).toMatchObject({
      liveBalance: 15507.46,
      used: 0.8,
      source: 'upstox',
      label: 'Upstox',
    });
  });

  it('reads nothing when the token belongs to another Upstox account', async () => {
    upstox.userId = 'SOMEONE-ELSE';
    await expect(readBalance(USER, 'upstox')).rejects.toMatchObject({ status: 409 });
    await expect(place()).rejects.toMatchObject({ status: 409 });
    expect(paths()).not.toContain('/v2/user/get-funds-and-margin');
    expect(upstox.calls.some((call) => call.url === ORDER_URL)).toBe(false);
  });
});

describe('Upstox orders', () => {
  it('places one NSE DAY LIMIT order with the documented body', async () => {
    expect(await place()).toEqual({ orderId: '1644490272000' });
    expect(paths()).toEqual([
      '/market-quote/instruments/exchange/NSE.json.gz',
      '/v2/user/profile',
      '/v3/order/place',
    ]);
    const sent = upstox.calls.at(-1).options;
    expect(sent.method).toBe('POST');
    expect(sent.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(sent.body);
    expect(Object.keys(body).sort()).toEqual(
      [
        'quantity',
        'product',
        'validity',
        'price',
        'tag',
        'instrument_token',
        'order_type',
        'transaction_type',
        'disclosed_quantity',
        'trigger_price',
        'is_amo',
        'slice',
      ].sort(),
    );
    expect(body.quantity).toBe(3);
    expect(body.product).toBe('D');
    expect(body.validity).toBe('DAY');
    expect(body.price).toBe(2450.5);
    expect(body.tag).toBe('blank');
    expect(body.instrument_token).toBe('NSE_EQ|INE002A01018');
    expect(body.order_type).toBe('LIMIT');
    expect(body.transaction_type).toBe('BUY');
    expect(body.disclosed_quantity).toBe(0);
    expect(body.trigger_price).toBe(0);
    expect(body.is_amo).toBe(false);
    expect(body.slice).toBe(false);

    // Intraday maps to I; the instrument list is now cached.
    await place({ product: 'MIS', side: 'SELL', symbol: 'm&m' });
    const intraday = JSON.parse(upstox.calls.at(-1).options.body);
    expect(intraday).toMatchObject({
      product: 'I',
      transaction_type: 'SELL',
      instrument_token: 'NSE_EQ|INE101A01026',
    });
    expect(paths().filter((path) => path.endsWith('NSE.json.gz'))).toHaveLength(1);
  });

  it('caches only NSE cash equities from the streamed master file', async () => {
    await place();
    const rows = await BrokerInstrument.find({ provider: 'upstox' }).sort({ _id: 1 }).lean();
    expect(rows.map((row) => [row._id, row.token, row.isin, row.lotSize])).toEqual([
      ['upstox:NSE:M&M', 'NSE_EQ|INE101A01026', 'INE101A01026', 1],
      ['upstox:NSE:RELIANCE', 'NSE_EQ|INE002A01018', 'INE002A01018', 1],
    ]);
  });

  it('refuses what it cannot place as given, before sending anything', async () => {
    await expect(place({ exchange: 'BSE' })).rejects.toMatchObject({ status: 400 });
    await expect(place({ product: 'NRML' })).rejects.toMatchObject({ status: 400 });
    // A BE-series row and an F&O contract are not cash equities.
    await expect(place({ symbol: 'JOCIL' })).rejects.toMatchObject({ status: 400 });
    expect(upstox.calls.some((call) => call.url === ORDER_URL)).toBe(false);
  });

  it('reports an unknown outcome whenever the order may have reached Upstox', async () => {
    const replies = [
      () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
      () => Promise.reject(new TypeError('fetch failed')),
      () => new Response('<html>Bad gateway</html>', { status: 502 }),
      () => Response.json({ status: 'error', errors: [] }, { status: 500 }),
      () => new Response('not json', { status: 200 }),
      () => Response.json({ status: 'success', data: {} }),
      () => Response.json({ status: 'success', data: { order_ids: ['1', '2'] } }),
    ];
    for (const reply of replies) {
      upstox.place = reply;
      const error = await place().catch((caught) => caught);
      expect(error).toMatchObject({ outcome: 'unknown', status: 504 });
      expect(error.message).toMatch(/Check your Upstox order book/);
    }
  });

  it('reports a refusal with Upstox’s reason, and a refused token as expired', async () => {
    upstox.place = () =>
      Response.json(
        {
          status: 'error',
          errors: [
            {
              error_code: 'UDAPI1154',
              message: 'Access to this API is blocked due to static IP restrictions.',
              property_path: null,
              invalid_value: null,
            },
          ],
        },
        { status: 400 },
      );
    const refused = await place().catch((error) => error);
    expect(refused.outcome).toBeUndefined();
    expect(refused.message).toBe(
      'Upstox rejected the order: Access to this API is blocked due to static IP restrictions.',
    );

    upstox.place = () => new Response('{}', { status: 401 });
    const expired = await place().catch((error) => error);
    expect(expired).toMatchObject({ status: 401, tokenRejected: true });
    expect(expired.outcome).toBeUndefined();
    const row = await BrokerConnection.findOne({ userId: USER, provider: 'upstox' }).lean();
    expect(row.expiresAt.getTime()).toBe(0);
  });

  it('maps order statuses: complete only when completely filled', async () => {
    const read = async (fields) => {
      upstox.details = order(fields);
      return adapter.readOrder(USER, '231019025562880');
    };
    expect(await read({})).toEqual({
      status: 'complete',
      filledQuantity: 1,
      averagePrice: 570.95,
      message: null,
    });
    expect(upstox.calls.at(-1).url).toBe(
      'https://api.upstox.com/v2/order/details?order_id=231019025562880',
    );
    expect(await read({ quantity: 5, filled_quantity: 2 })).toMatchObject({
      status: 'open',
      filledQuantity: 2,
    });
    for (const status of [
      'open',
      'trigger pending',
      'modified',
      'validation pending',
      'put order req received',
      'not cancelled',
      'after market order req received',
    ]) {
      expect((await read({ status, filled_quantity: 0, pending_quantity: 1 })).status).toBe('open');
    }
    expect(
      await read({
        status: 'rejected',
        filled_quantity: 0,
        average_price: 0,
        status_message: 'You need to add Rs. 138385.27 in your account to place this trade.',
      }),
    ).toEqual({
      status: 'rejected',
      filledQuantity: 0,
      averagePrice: 0,
      message: 'You need to add Rs. 138385.27 in your account to place this trade.',
    });
    expect((await read({ status: 'cancelled', filled_quantity: 0 })).status).toBe('cancelled');
    expect((await read({ status: 'cancelled after market order' })).status).toBe('cancelled');
    await expect(read({ filled_quantity: null })).rejects.toMatchObject({ status: 502 });
    await expect(adapter.readOrder(USER, '../user/profile')).rejects.toMatchObject({
      status: 400,
    });
  });
});
