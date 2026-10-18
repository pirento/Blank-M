// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextIstTime } from '../../services/broker/broker-api.js';
import { upstoxCarried, upstoxTradesToFills } from '../../services/broker/upstox.js';

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');

const realFetch = globalThis.fetch;
const ACCESS_TOKEN = 'upstox-access-token-0123456789abcdef';
const istNow = () =>
  new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const trade = (id, side, price, extra = {}) => ({
  exchange: 'NSE',
  product: 'I',
  trading_symbol: 'TCS',
  transaction_type: side,
  quantity: 4,
  average_price: price,
  trade_id: id,
  order_id: `O${id}`,
  exchange_timestamp: istNow(),
  ...extra,
});

let app;
let upstox;
beforeAll(async () => {
  Object.assign(process.env, {
    BROKER_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    APP_URL: 'http://blank.test',
    UPSTOX_API_KEY: 'upstox-key',
    UPSTOX_API_SECRET: 'upstox-secret',
  });
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of ['APP_URL', 'UPSTOX_API_KEY', 'UPSTOX_API_SECRET']) delete process.env[key];
  await stopTestApp();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  await resetDatabase();
  upstox = {
    trades: [trade('T1', 'BUY', 3400), trade('T2', 'SELL', 3410)],
    positions: [],
    holdings: [],
    status: 200,
    calls: [],
  };
  // Supertest talks to the app over loopback; only Upstox calls are faked.
  globalThis.fetch = vi.fn(async (url, options) => {
    if (!String(url).startsWith('https://api.upstox.com/')) return realFetch(url, options);
    const path = new URL(url).pathname;
    upstox.calls.push({ path, options });
    if (path === '/v2/login/authorization/token') {
      return Response.json({ access_token: ACCESS_TOKEN, user_id: 'UPX123', email: 'x@y.z' });
    }
    if (upstox.status !== 200) return new Response('{}', { status: upstox.status });
    const data = {
      '/v2/order/trades/get-trades-for-day': upstox.trades,
      '/v2/portfolio/short-term-positions': upstox.positions,
      '/v2/portfolio/long-term-holdings': upstox.holdings,
    }[path];
    return Response.json({ status: 'success', data });
  });
});

async function member() {
  const { password } = await createMember();
  const session = await signIn(app, { email: 'member@example.com', password });
  const post = (path, body) =>
    session.agent.post(path).set('X-CSRF-Token', session.csrf).send(body);
  return { ...session, post };
}

async function connect(session) {
  const started = await session.post('/api/upstox/authorize', {});
  expect(started.status).toBe(200);
  const state = new URL(started.body.url).searchParams.get('state');
  const back = await session.agent.get(`/api/upstox/callback?code=auth-code-1&state=${state}`);
  expect(back.headers.location).toBe('/settings?broker=upstox&result=connected');
  return state;
}

describe('Upstox fills', () => {
  it('logs in over OAuth, previews today’s fills and imports them once', async () => {
    const session = await member();
    expect((await session.agent.get('/api/upstox')).body).toMatchObject({
      configured: true,
      connected: false,
    });

    const started = await session.post('/api/upstox/authorize', {});
    const url = new URL(started.body.url);
    expect(url.origin + url.pathname).toBe('https://api.upstox.com/v2/login/authorization/dialog');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'upstox-key',
      redirect_uri: 'http://blank.test/api/upstox/callback',
    });

    // A state this browser did not start is refused before any token exchange.
    const forged = await session.agent.get(
      `/api/upstox/callback?code=auth-code-1&state=${'x'.repeat(43)}`,
    );
    expect(forged.status).toBe(303);
    expect(forged.headers.location).toBe('/settings?broker=upstox&result=failed');
    expect(upstox.calls).toEqual([]);

    const state = await connect(session);
    const exchange = upstox.calls.find((call) => call.path.endsWith('/token'));
    expect(exchange.options.method).toBe('POST');
    expect(exchange.options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(exchange.options.body))).toEqual({
      code: 'auth-code-1',
      client_id: 'upstox-key',
      client_secret: 'upstox-secret',
      redirect_uri: 'http://blank.test/api/upstox/callback',
      grant_type: 'authorization_code',
    });
    // The state is single use.
    const replay = await session.agent.get(`/api/upstox/callback?code=again&state=${state}`);
    expect(replay.headers.location).toBe('/settings?broker=upstox&result=failed');

    const status = await session.agent.get('/api/upstox');
    expect(status.body).toMatchObject({ connected: true, clientId: 'UPX123' });
    expect(JSON.stringify(status.body)).not.toContain(ACCESS_TOKEN);
    expect(new Date(status.body.expiresAt).toISOString()).toBe(nextIstTime(3, 30).toISOString());

    upstox.calls = [];
    const preview = await session.agent.get('/api/upstox/fills');
    expect(preview.status).toBe(200);
    expect(upstox.calls[0].options.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(preview.body.candidates).toEqual([
      expect.objectContaining({ symbol: 'TCS', type: 'Long', quantity: 4, grossPnl: 40 }),
    ]);
    const [trip] = preview.body.candidates;
    const first = await session.post('/api/upstox/fills/import', { ids: [trip.id] });
    expect(first.body.added).toEqual([
      expect.objectContaining({ notes: expect.stringContaining('Added from Upstox fills') }),
    ]);
    expect((await session.post('/api/upstox/fills/import', { ids: [trip.id] })).body).toMatchObject(
      { added: [], skipped: 1 },
    );

    // A revoked token marks the connection expired.
    upstox.status = 401;
    expect((await session.agent.get('/api/upstox/fills')).status).toBe(401);
    expect((await session.agent.get('/api/upstox')).body).toMatchObject({
      connected: false,
      expired: true,
    });
    expect((await session.post('/api/upstox/disconnect', {})).body).toMatchObject({
      connected: false,
      clientId: null,
    });
  });

  it('keeps a position carried from yesterday out of today’s round trips', async () => {
    const session = await member();
    await connect(session);
    // Held 4 TCS overnight (delivery): sell them, then a 4-share intraday round trip.
    upstox.trades = [
      trade('C1', 'SELL', 3390, { product: 'D' }),
      trade('T1', 'BUY', 3400),
      trade('T2', 'SELL', 3410),
    ];
    upstox.holdings = [{ trading_symbol: 'TCS', exchange: 'NSE', quantity: 4, t1_quantity: 0 }];
    const preview = await session.agent.get('/api/upstox/fills');
    expect(preview.body.candidates).toEqual([
      expect.objectContaining({ symbol: 'TCS', type: 'Long', quantity: 4, product: 'MIS' }),
    ]);
    expect(preview.body.open).toEqual([]);
    expect(preview.body.skipped).toEqual([
      expect.objectContaining({
        symbol: 'TCS',
        quantity: 4,
        reason: expect.stringContaining('carried'),
      }),
    ]);
  });

  it('says when the administrator has not set app keys', async () => {
    const session = await member();
    delete process.env.UPSTOX_API_SECRET;
    try {
      expect((await session.agent.get('/api/upstox')).body).toMatchObject({ configured: false });
      const started = await session.post('/api/upstox/authorize', {});
      expect(started.status).toBe(503);
      expect(started.body.error).toContain('administrator has not set Upstox app keys');
    } finally {
      process.env.UPSTOX_API_SECRET = 'upstox-secret';
    }
  });
});

describe('Upstox mapping', () => {
  it('maps symbols and products and lists unreadable rows', () => {
    const at = '2026-10-12 10:15:00';
    const { fills, skipped } = upstoxTradesToFills(
      [
        trade('E', 'BUY', 800, { trading_symbol: 'SBIN-EQ', exchange_timestamp: at, product: 'D' }),
        trade('F', 'BUY', 120, {
          exchange: 'NFO',
          trading_symbol: 'NIFTY 25000 CE 27 OCT 26',
          product: 'D',
          exchange_timestamp: '12-Oct-2026 10:16:00',
        }),
        trade('G', 'SELL', 200, {
          exchange: 'NFO',
          trading_symbol: 'NIFTY26OCTFUT',
          exchange_timestamp: at,
        }),
        trade('H', 'BUY', 1, {
          exchange: 'NFO',
          trading_symbol: 'NIFTY-OCT-25000',
          exchange_timestamp: at,
        }),
        trade('I', 'HOLD', 1, { exchange_timestamp: at }),
        trade('Y', 'BUY', 1, { exchange_timestamp: '2026-10-11 10:15:00' }),
      ],
      '2026-10-12',
    );
    expect(fills.map((fill) => [fill.symbol, fill.exchange, fill.product, fill.filledAt])).toEqual([
      ['SBIN', 'NSE', 'CNC', '2026-10-12T04:45:00.000Z'],
      ['NIFTY26OCT25000CE', 'NFO', 'NRML', '2026-10-12T04:46:00.000Z'],
      ['NIFTY26OCTFUT', 'NFO', 'MIS', '2026-10-12T04:45:00.000Z'],
    ]);
    expect(skipped).toEqual([
      expect.objectContaining({
        symbol: 'NIFTY-OCT-25000',
        reason: expect.stringContaining('could not be read'),
      }),
      expect.objectContaining({ symbol: 'TCS', reason: 'The buy/sell side is missing.' }),
    ]);
  });

  it('keys carried positions like the fills', () => {
    const carried = upstoxCarried(
      [
        { exchange: 'NFO', product: 'D', trading_symbol: 'NIFTY26OCTFUT', overnight_quantity: -75 },
        { exchange: 'NSE', product: 'I', trading_symbol: 'TCS', overnight_buy_quantity: 0 },
        { exchange: 'NSE', product: 'D', trading_symbol: 'TCS', overnight_quantity: 5 },
      ],
      [{ trading_symbol: 'INFY', quantity: 3, t1_quantity: 2 }],
    );
    expect(Object.fromEntries(carried)).toEqual({
      'NFO:NIFTY26OCTFUT:NRML': -75,
      'NSE:INFY:CNC': 5,
      'BSE:INFY:CNC': 5,
    });
  });

  it('expires tokens at the next 03:30 IST', () => {
    // 16:30 IST → 03:30 IST next day; 01:00 IST → 03:30 IST the same day.
    expect(nextIstTime(3, 30, new Date('2026-10-16T11:00:00Z')).toISOString()).toBe(
      '2026-10-16T22:00:00.000Z',
    );
    expect(nextIstTime(3, 30, new Date('2026-10-16T19:30:00Z')).toISOString()).toBe(
      '2026-10-16T22:00:00.000Z',
    );
  });
});
