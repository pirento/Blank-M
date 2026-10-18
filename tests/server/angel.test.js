// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { angelCarried, angelTradesToFills } from '../../services/broker/angel.js';
import { decryptSecret } from '../../services/crypto.js';

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const { BrokerConnection } = await import('../../models/index.js');

const realFetch = globalThis.fetch;
const JWT = 'eyJhbGciOiJIUzUxMiJ9.eyJ1c2VybmFtZSI6IkExMjMifQ.angel-signature';
const PIN = '97531864';
const TOTP = '864213';
const LOGIN = { apiKey: 'smartKey01', clientCode: 'a123456', pin: PIN, totp: TOTP };
const istClock = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(11, 19);
const trade = (id, side, price, extra = {}) => ({
  exchange: 'NSE',
  producttype: 'INTRADAY',
  tradingsymbol: 'TCS-EQ',
  transactiontype: side,
  fillsize: '4',
  fillprice: String(price),
  filltime: istClock(),
  fillid: id,
  orderid: `O${id}`,
  ...extra,
});

let app;
let angel;
beforeAll(async () => {
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  app = await startTestApp();
});
afterAll(stopTestApp);
afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  await resetDatabase();
  angel = {
    trades: [trade('T1', 'BUY', 3400), trade('T2', 'SELL', 3410)],
    positions: [],
    holdings: null,
    login: { status: true, message: 'SUCCESS', data: { jwtToken: `Bearer ${JWT}` } },
    reply: null,
    calls: [],
  };
  // Supertest talks to the app over loopback; only Angel One calls are faked.
  globalThis.fetch = vi.fn(async (url, options) => {
    if (!String(url).startsWith('https://apiconnect.angelone.in/')) return realFetch(url, options);
    const path = new URL(url).pathname;
    angel.calls.push({ path, options });
    if (path.endsWith('/loginByPassword')) return Response.json(angel.login);
    if (angel.reply) return Response.json(angel.reply);
    const data = path.endsWith('/getTradeBook')
      ? angel.trades
      : path.endsWith('/getPosition')
        ? angel.positions
        : angel.holdings;
    return Response.json({ status: true, message: 'SUCCESS', data });
  });
});

async function member() {
  const { password } = await createMember();
  const session = await signIn(app, { email: 'member@example.com', password });
  const post = (path, body) =>
    session.agent.post(path).set('X-CSRF-Token', session.csrf).send(body);
  return { ...session, post };
}

describe('Angel One fills', () => {
  it('logs in without storing the PIN or TOTP, previews today’s fills and imports them once', async () => {
    const session = await member();
    expect((await session.agent.get('/api/angel')).body).toMatchObject({
      configured: true,
      connected: false,
    });
    expect((await session.post('/api/angel/connect', { ...LOGIN, totp: '12' })).status).toBe(400);
    expect(angel.calls).toEqual([]);

    const connected = await session.post('/api/angel/connect', LOGIN);
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({ connected: true, clientId: 'A123456' });
    const [login] = angel.calls;
    expect(JSON.parse(login.options.body)).toEqual({
      clientcode: 'A123456',
      password: PIN,
      totp: TOTP,
    });
    expect(login.options.headers).toMatchObject({
      'X-PrivateKey': 'smartKey01',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
    });

    // Only the API key and the session are stored, encrypted.
    const row = await BrokerConnection.findOne({ provider: 'angel' }).lean();
    const raw = JSON.stringify(row);
    for (const secret of [PIN, TOTP, JWT, 'smartKey01']) expect(raw).not.toContain(secret);
    expect(
      JSON.parse(
        decryptSecret({
          ciphertext: row.accessTokenCiphertext,
          iv: row.accessTokenIv,
          tag: row.accessTokenTag,
        }),
      ),
    ).toEqual({ apiKey: 'smartKey01', jwt: JWT });
    expect(JSON.stringify(connected.body)).not.toContain(JWT);

    angel.calls = [];
    const preview = await session.agent.get('/api/angel/fills');
    expect(preview.status).toBe(200);
    expect(angel.calls[0].options.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(preview.body.candidates).toEqual([
      expect.objectContaining({
        symbol: 'TCS',
        type: 'Long',
        quantity: 4,
        grossPnl: 40,
        product: 'MIS',
      }),
    ]);
    const ids = preview.body.candidates.map((trip) => trip.id);
    expect((await session.post('/api/angel/fills/import', { ids })).body.added).toEqual([
      expect.objectContaining({ notes: expect.stringContaining('Added from Angel One fills') }),
    ]);
    expect((await session.post('/api/angel/fills/import', { ids })).body).toMatchObject({
      added: [],
      skipped: 1,
    });

    // An ended session marks the connection expired.
    angel.reply = { success: false, message: 'Invalid Token', errorCode: 'AG8001', data: '' };
    expect((await session.agent.get('/api/angel/fills')).status).toBe(401);
    expect((await session.agent.get('/api/angel')).body).toMatchObject({
      connected: false,
      expired: true,
    });
  });

  it('shows Angel One’s reason for a refused login and stores nothing', async () => {
    const session = await member();
    angel.login = { status: false, message: 'Invalid totp', errorcode: 'AB1050', data: null };
    const refused = await session.post('/api/angel/connect', LOGIN);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('Invalid totp');
    expect(await BrokerConnection.countDocuments({})).toBe(0);
  });

  it('keeps a holding carried from yesterday out of today’s round trips', async () => {
    const session = await member();
    await session.post('/api/angel/connect', LOGIN);
    angel.trades = [
      trade('C1', 'SELL', 3390, { producttype: 'DELIVERY' }),
      trade('T1', 'BUY', 3400),
      trade('T2', 'SELL', 3410),
    ];
    angel.holdings = [{ tradingsymbol: 'TCS-EQ', exchange: 'NSE', quantity: '4', t1quantity: '0' }];
    const preview = await session.agent.get('/api/angel/fills');
    expect(preview.body.candidates).toHaveLength(1);
    expect(preview.body.open).toEqual([]);
    expect(preview.body.skipped).toEqual([expect.objectContaining({ symbol: 'TCS', quantity: 4 })]);
  });
});

describe('Angel One mapping', () => {
  it('maps dated F&O names, products and string numbers and lists unreadable rows', () => {
    const { fills, skipped } = angelTradesToFills(
      [
        trade('M', 'BUY', 120.5, {
          exchange: 'NFO',
          producttype: 'CARRYFORWARD',
          tradingsymbol: 'NIFTY27OCT2625000CE',
          filltime: '10:15:00',
        }),
        trade('W', 'SELL', 80, {
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY06OCT2654000PE',
          filltime: '10:16:00',
        }),
        trade('F', 'BUY', 25000, {
          exchange: 'NFO',
          tradingsymbol: 'NIFTY27OCT26FUT',
          filltime: '10:17:00',
        }),
        trade('B', 'BUY', 800, {
          exchange: 'BSE',
          producttype: 'DELIVERY',
          tradingsymbol: 'SBIN',
          filltime: '10:18:00',
        }),
        trade('X', 'BUY', 1, {
          exchange: 'NFO',
          tradingsymbol: 'NIFTY31FEB2625000CE',
          filltime: '10:19:00',
        }),
        trade('Q', 'BUY', 1, { fillsize: '0', filltime: '10:20:00' }),
      ],
      '2026-10-12',
    );
    expect(fills.map((fill) => [fill.symbol, fill.exchange, fill.product, fill.quantity])).toEqual([
      ['NIFTY26OCT25000CE', 'NFO', 'NRML', 4],
      ['BANKNIFTY26O0654000PE', 'NFO', 'MIS', 4],
      ['NIFTY26OCTFUT', 'NFO', 'MIS', 4],
      ['SBIN', 'BSE', 'CNC', 4],
    ]);
    expect(fills[0]).toMatchObject({ averagePrice: 120.5, filledAt: '2026-10-12T04:45:00.000Z' });
    expect(skipped.map((row) => row.reason)).toEqual([
      'The Angel One contract name could not be read reliably. Add this trade by hand.',
      'The quantity is missing or invalid.',
    ]);
  });

  it('keys carried positions and holdings like the fills', () => {
    const carried = angelCarried(
      [
        {
          exchange: 'NFO',
          producttype: 'CARRYFORWARD',
          tradingsymbol: 'NIFTY27OCT26FUT',
          cfbuyqty: '75',
          cfsellqty: '0',
        },
        {
          exchange: 'NSE',
          producttype: 'DELIVERY',
          tradingsymbol: 'TCS-EQ',
          cfbuyqty: '5',
          cfsellqty: '0',
        },
      ],
      [{ tradingsymbol: 'INFY-EQ', quantity: '3', t1quantity: '2' }],
    );
    expect(Object.fromEntries(carried)).toEqual({
      'NFO:NIFTY26OCTFUT:NRML': 75,
      'NSE:INFY:CNC': 5,
      'BSE:INFY:CNC': 5,
    });
  });
});
