// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fyersCarried, fyersTradesToFills } from '../../services/broker/fyers.js';

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');

const realFetch = globalThis.fetch;
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const ACCESS_TOKEN = `${base64url({ alg: 'HS256' })}.${base64url({ fy_id: 'XA12345' })}.signature`;
const istNow = () => {
  const ist = new Date(Date.now() + 330 * 60_000);
  const month = ist.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  return `${String(ist.getUTCDate()).padStart(2, '0')}-${month}-${ist.getUTCFullYear()} ${ist.toISOString().slice(11, 19)}`;
};
const trade = (id, side, price, extra = {}) => ({
  symbol: 'NSE:TCS-EQ',
  segment: 10,
  side,
  tradedQty: 4,
  tradePrice: price,
  productType: 'INTRADAY',
  tradeNumber: id,
  orderNumber: `O${id}`,
  orderDateTime: istNow(),
  ...extra,
});

let app;
let fyers;
beforeAll(async () => {
  Object.assign(process.env, {
    BROKER_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    APP_URL: 'http://blank.test',
    FYERS_APP_ID: 'ABCD1234-100',
    FYERS_SECRET_ID: 'fyers-secret',
  });
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of ['APP_URL', 'FYERS_APP_ID', 'FYERS_SECRET_ID']) delete process.env[key];
  await stopTestApp();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  await resetDatabase();
  fyers = {
    trades: [trade('T1', 1, 3400), trade('T2', -1, 3410)],
    positions: [],
    holdings: [],
    reply: null,
    calls: [],
  };
  // Supertest talks to the app over loopback; only Fyers calls are faked.
  globalThis.fetch = vi.fn(async (url, options) => {
    if (!String(url).startsWith('https://api-t1.fyers.in/')) return realFetch(url, options);
    const path = new URL(url).pathname;
    fyers.calls.push({ path, options });
    if (path === '/api/v3/validate-authcode') {
      return Response.json({ s: 'ok', code: 200, access_token: ACCESS_TOKEN });
    }
    if (fyers.reply) return Response.json(fyers.reply);
    if (path === '/api/v3/tradebook') return Response.json({ s: 'ok', tradeBook: fyers.trades });
    if (path === '/api/v3/positions')
      return Response.json({ s: 'ok', netPositions: fyers.positions });
    return Response.json({ s: 'ok', holdings: fyers.holdings });
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
  const started = await session.post('/api/fyers/authorize', {});
  const state = new URL(started.body.url).searchParams.get('state');
  // Fyers sends its own `code` (a status) next to the real auth_code.
  const back = await session.agent.get(
    `/api/fyers/callback?s=ok&code=200&auth_code=fyers-auth-code&state=${state}`,
  );
  expect(back.headers.location).toBe('/settings?broker=fyers&result=connected');
}

describe('Fyers fills', () => {
  it('logs in over OAuth, previews today’s fills and imports them once', async () => {
    const session = await member();
    const started = await session.post('/api/fyers/authorize', {});
    const url = new URL(started.body.url);
    expect(url.origin + url.pathname).toBe('https://api-t1.fyers.in/api/v3/generate-authcode');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'ABCD1234-100',
      redirect_uri: 'http://blank.test/api/fyers/callback',
      response_type: 'code',
    });
    const wrong = await session.agent.get(
      `/api/fyers/callback?auth_code=x&state=${url.searchParams.get('state')}x`,
    );
    expect(wrong.headers.location).toBe('/settings?broker=fyers&result=failed');
    expect(fyers.calls).toEqual([]);

    await connect(session);
    const exchange = fyers.calls.find((call) => call.path.endsWith('/validate-authcode'));
    expect(JSON.parse(exchange.options.body)).toEqual({
      grant_type: 'authorization_code',
      appIdHash: createHash('sha256').update('ABCD1234-100:fyers-secret').digest('hex'),
      code: 'fyers-auth-code',
    });
    const status = await session.agent.get('/api/fyers');
    expect(status.body).toMatchObject({ configured: true, connected: true, clientId: 'XA12345' });
    expect(JSON.stringify(status.body)).not.toContain(ACCESS_TOKEN);

    fyers.calls = [];
    const preview = await session.agent.get('/api/fyers/fills');
    expect(preview.status).toBe(200);
    expect(fyers.calls[0].options.headers.Authorization).toBe(`ABCD1234-100:${ACCESS_TOKEN}`);
    expect(preview.body.candidates).toEqual([
      expect.objectContaining({ symbol: 'TCS', type: 'Long', quantity: 4, grossPnl: 40 }),
    ]);
    const ids = preview.body.candidates.map((trip) => trip.id);
    expect((await session.post('/api/fyers/fills/import', { ids })).body.added).toHaveLength(1);
    expect((await session.post('/api/fyers/fills/import', { ids })).body).toMatchObject({
      added: [],
      skipped: 1,
    });

    // Fyers answers an expired token with an error code; the connection is marked expired.
    fyers.reply = { s: 'error', code: -16, message: 'Could not authenticate the user' };
    expect((await session.agent.get('/api/fyers/fills')).status).toBe(401);
    expect((await session.agent.get('/api/fyers')).body).toMatchObject({
      connected: false,
      expired: true,
    });
  });

  it('keeps an F&O position carried from yesterday out of today’s round trips', async () => {
    const session = await member();
    await connect(session);
    const fno = { symbol: 'NSE:NIFTY26OCTFUT', segment: 11, productType: 'MARGIN', tradedQty: 75 };
    fyers.trades = [
      trade('C1', -1, 25000, fno),
      trade('T1', 1, 25010, fno),
      trade('T2', -1, 25020, fno),
    ];
    fyers.positions = [
      {
        symbol: 'NSE:NIFTY26OCTFUT',
        segment: 11,
        productType: 'MARGIN',
        cfBuyQty: 75,
        cfSellQty: 0,
      },
    ];
    const preview = await session.agent.get('/api/fyers/fills');
    expect(preview.body.candidates).toEqual([
      expect.objectContaining({
        symbol: 'NIFTY26OCTFUT',
        type: 'Long',
        quantity: 75,
        product: 'NRML',
      }),
    ]);
    expect(preview.body.open).toEqual([]);
  });
});

describe('Fyers mapping', () => {
  it('maps symbols, sides and products and lists unreadable rows', () => {
    const at = '12-Oct-2026 10:15:00';
    const { fills, skipped } = fyersTradesToFills(
      [
        trade('E', 1, 800, {
          symbol: 'BSE:SBIN-EQ',
          segment: 10,
          productType: 'CNC',
          orderDateTime: at,
        }),
        trade('W', -1, 50, { symbol: 'NSE:NIFTY2610625000CE', segment: 11, orderDateTime: at }),
        trade('X', 1, 50, { symbol: 'NSE:NIFTY 25000 CE', segment: 11, orderDateTime: at }),
        trade('C', 1, 83, { symbol: 'NSE:USDINR26OCTFUT', segment: 12, orderDateTime: at }),
        trade('S', 0, 1, { orderDateTime: at }),
        trade('Y', 1, 1, { orderDateTime: '11-Oct-2026 10:15:00' }),
      ],
      '2026-10-12',
    );
    expect(fills.map((fill) => [fill.symbol, fill.exchange, fill.product, fill.side])).toEqual([
      ['SBIN', 'BSE', 'CNC', 'BUY'],
      ['NIFTY2610625000CE', 'NFO', 'MIS', 'SELL'],
      // Currency is passed on; shared/broker-fills.js skips that exchange with its own reason.
      ['USDINR26OCTFUT', 'NSE-12', 'MIS', 'BUY'],
    ]);
    expect(fills[0].filledAt).toBe('2026-10-12T04:45:00.000Z');
    expect(skipped.map((row) => row.reason)).toEqual([
      'The Fyers contract name could not be read reliably. Add this trade by hand.',
      'The buy/sell side is missing.',
    ]);
  });

  it('keys carried positions and holdings like the fills', () => {
    const carried = fyersCarried(
      [
        {
          symbol: 'NSE:NIFTY26OCTFUT',
          segment: 11,
          productType: 'MARGIN',
          cfBuyQty: 0,
          cfSellQty: 75,
        },
        { symbol: 'NSE:TCS-EQ', segment: 10, productType: 'CNC', cfBuyQty: 5, cfSellQty: 0 },
      ],
      [
        { symbol: 'NSE:INFY-EQ', quantity: 3, remainingQuantity: 3 },
        { symbol: 'NSE:INFY-EQ', quantity: 2, remainingQuantity: 2 },
      ],
    );
    expect(Object.fromEntries(carried)).toEqual({
      'NFO:NIFTY26OCTFUT:NRML': -75,
      'NSE:INFY:CNC': 5,
      'BSE:INFY:CNC': 5,
    });
  });
});
