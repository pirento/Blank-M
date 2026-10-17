// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contractSymbol, dhanTradesToFills, dhanTokenClaims } from '../../services/broker/dhan.js';

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');

const realFetch = globalThis.fetch;
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (claims) => `${base64url({ alg: 'HS512' })}.${base64url(claims)}.signature`;
const istNow = () =>
  new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');

let app;
let dhan;
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
  const time = istNow();
  dhan = {
    trades: [
      {
        exchangeTradeId: 'T1',
        orderId: 'O1',
        transactionType: 'BUY',
        exchangeSegment: 'NSE_EQ',
        productType: 'INTRADAY',
        tradingSymbol: 'TCS',
        tradedQuantity: 4,
        tradedPrice: 3400,
        exchangeTime: time,
      },
      {
        exchangeTradeId: 'T2',
        orderId: 'O2',
        transactionType: 'SELL',
        exchangeSegment: 'NSE_EQ',
        productType: 'INTRADAY',
        tradingSymbol: 'TCS',
        tradedQuantity: 4,
        tradedPrice: 3410,
        exchangeTime: time,
      },
    ],
    positions: [],
    holdings: [],
    status: 200,
    calls: [],
  };
  // Supertest talks to the app over loopback; only Dhan calls are faked.
  globalThis.fetch = vi.fn(async (url, options) => {
    if (!String(url).startsWith('https://api.dhan.co/')) return realFetch(url, options);
    dhan.calls.push({ url: String(url), token: options.headers['access-token'] });
    if (dhan.status !== 200) return new Response('{}', { status: dhan.status });
    if (String(url).endsWith('/profile')) {
      return Response.json({ dhanClientId: '1100000001', tokenValidity: '30/12/2026 10:00' });
    }
    if (String(url).endsWith('/positions')) return Response.json(dhan.positions);
    if (String(url).endsWith('/holdings')) {
      // Dhan answers an empty demat with an error.
      return dhan.holdings.length
        ? Response.json(dhan.holdings)
        : Response.json({ errorCode: 'DH-1111' }, { status: 500 });
    }
    return Response.json(dhan.trades);
  });
});

describe('Dhan fills', () => {
  it('connects with a token, previews today’s fills and imports them once', async () => {
    const { password } = await createMember();
    const session = await signIn(app, { email: 'member@example.com', password });
    const post = (path, body) =>
      session.agent.post(path).set('X-CSRF-Token', session.csrf).send(body);
    const accessToken = token({
      dhanClientId: '1100000001',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    expect((await session.agent.get('/api/dhan')).body).toMatchObject({ connected: false });
    expect((await post('/api/dhan/connect', { accessToken: 'short' })).status).toBe(400);
    const connected = await post('/api/dhan/connect', { accessToken });
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({ connected: true, clientId: '1100000001' });
    expect(JSON.stringify(connected.body)).not.toContain(accessToken);

    const preview = await session.agent.get('/api/dhan/fills');
    expect(preview.status).toBe(200);
    expect(dhan.calls).toContainEqual({ url: 'https://api.dhan.co/v2/trades', token: accessToken });
    expect(preview.body.candidates).toEqual([
      expect.objectContaining({ symbol: 'TCS', type: 'Long', quantity: 4, grossPnl: 40 }),
    ]);
    const [trip] = preview.body.candidates;
    const first = await post('/api/dhan/fills/import', { ids: [trip.id] });
    expect(first.body.added).toEqual([
      expect.objectContaining({
        symbol: 'TCS',
        notes: expect.stringContaining('Added from Dhan fills'),
      }),
    ]);
    expect((await post('/api/dhan/fills/import', { ids: [trip.id] })).body).toMatchObject({
      added: [],
      skipped: 1,
    });

    // A revoked token marks the connection expired.
    dhan.status = 401;
    expect((await session.agent.get('/api/dhan/fills')).status).toBe(401);
    expect((await session.agent.get('/api/dhan')).body).toMatchObject({
      connected: false,
      expired: true,
    });

    expect((await post('/api/dhan/disconnect', {})).body).toMatchObject({
      connected: false,
      clientId: null,
    });
  });

  it('keeps a position carried from yesterday out of today’s round trips', async () => {
    const { password } = await createMember();
    const session = await signIn(app, { email: 'member@example.com', password });
    const accessToken = token({
      dhanClientId: '1100000001',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    await session.agent
      .post('/api/dhan/connect')
      .set('X-CSRF-Token', session.csrf)
      .send({ accessToken });
    // Held 4 TCS overnight (margin): sell them, then a 4-share intraday round trip.
    const [buy, sell] = dhan.trades.map((row) => ({ ...row, productType: 'MARGIN' }));
    dhan.trades = [
      { ...sell, exchangeTradeId: 'C1', tradedPrice: 3390 },
      { ...buy, exchangeTradeId: 'T1' },
      { ...sell, exchangeTradeId: 'T2' },
    ];
    dhan.positions = [
      {
        exchangeSegment: 'NSE_EQ',
        productType: 'MARGIN',
        tradingSymbol: 'TCS',
        carryForwardBuyQty: 4,
        carryForwardSellQty: 0,
      },
    ];
    const preview = await session.agent.get('/api/dhan/fills');
    expect(preview.status).toBe(200);
    expect(preview.body.candidates).toEqual([
      expect.objectContaining({ symbol: 'TCS', type: 'Long', quantity: 4, grossPnl: 40 }),
    ]);
    expect(preview.body.open).toEqual([]);
  });

  it('needs a connection before reading fills', async () => {
    const { password } = await createMember();
    const session = await signIn(app, { email: 'member@example.com', password });
    expect((await session.agent.get('/api/dhan/fills')).status).toBe(409);
  });
});

describe('Dhan trade book mapping', () => {
  it('reads token claims without trusting them', () => {
    expect(dhanTokenClaims(token({ dhanClientId: 7, exp: 2_000_000_000 }))).toEqual({
      clientId: '7',
      expiresAt: new Date(2_000_000_000_000),
    });
    expect(dhanTokenClaims('not-a-jwt')).toEqual({ clientId: null, expiresAt: null });
  });

  it('maps equity and F&O rows and drops other days and bad rows', () => {
    const row = {
      exchangeTradeId: 'X',
      orderId: 'O',
      transactionType: 'BUY',
      exchangeSegment: 'NSE_FNO',
      productType: 'MARGIN',
      tradingSymbol: 'NIFTY-Oct2026-25000-CE',
      tradedQuantity: 75,
      tradedPrice: 120.5,
      exchangeTime: '2026-10-12 10:15:00',
      drvExpiryDate: '2026-10-27 14:30:00',
      drvOptionType: 'CALL',
      drvStrikePrice: 25000,
    };
    const fills = dhanTradesToFills(
      [
        row,
        { ...row, exchangeTradeId: 'F', drvOptionType: null, drvStrikePrice: 0 },
        { ...row, exchangeTradeId: 'E', exchangeSegment: 'BSE_EQ', tradingSymbol: 'SBIN-EQ' },
        { ...row, exchangeTradeId: 'Y', exchangeTime: '2026-10-11 10:15:00' },
        { ...row, exchangeTradeId: 'Z', transactionType: 'HOLD' },
      ],
      '2026-10-12',
    );
    expect(fills.map((fill) => [fill.symbol, fill.exchange, fill.tradeId])).toEqual([
      ['NIFTY26OCT25000CE', 'NFO', 'X'],
      ['NIFTY26OCTFUT', 'NFO', 'F'],
      ['SBIN', 'BSE', 'E'],
    ]);
    // A weekly expiry keeps its day, so two expiries of one strike stay apart.
    expect(contractSymbol({ ...row, drvExpiryDate: '2026-10-06 14:30:00' })).toBe(
      'NIFTY26O0625000CE',
    );
    expect(contractSymbol({ ...row, drvExpiryDate: '2026-05-12', drvOptionType: 'PUT' })).toBe(
      'NIFTY2651225000PE',
    );
    expect(fills[0]).toMatchObject({
      side: 'BUY',
      quantity: 75,
      averagePrice: 120.5,
      product: 'MARGIN',
      filledAt: '2026-10-12T04:45:00.000Z',
    });
  });
});
