// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const telegram = vi.hoisted(() => ({ sent: [] }));
vi.mock('../../services/telegram/api.js', async (original) => ({
  ...(await original()),
  sendTelegramMessage: async (chatId, text) => {
    telegram.sent.push({ chatId: String(chatId), text });
  },
}));

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const supertest = (await import('supertest')).default;
const { TelegramLink } = await import('../../models/index.js');
const { runDailyImports } = await import('../../services/broker/daily-import.js');

// Friday 16 Oct 2026, 16:30 IST.
const AFTER_CLOSE = new Date('2026-10-16T11:00:00Z');
const realFetch = globalThis.fetch;
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const dhanToken = `${base64url({ alg: 'HS512' })}.${base64url({
  dhanClientId: '1100000001',
  exp: Math.floor(AFTER_CLOSE.getTime() / 1000) + 3600,
})}.signature`;
const fill = (id, side, price) => ({
  exchangeTradeId: id,
  orderId: `O${id}`,
  transactionType: side,
  exchangeSegment: 'NSE_EQ',
  productType: 'INTRADAY',
  tradingSymbol: 'TCS',
  tradedQuantity: 4,
  tradedPrice: price,
  exchangeTime: '2026-10-16 10:15:00',
});

let app;
beforeAll(async () => {
  Object.assign(process.env, {
    BROKER_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_BOT_USERNAME: 'blank_test_bot',
    TELEGRAM_WEBHOOK_SECRET: 'z'.repeat(40),
  });
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET'])
    delete process.env[key];
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  telegram.sent = [];
  vi.useFakeTimers({ toFake: ['Date'], now: AFTER_CLOSE });
  globalThis.fetch = vi.fn(async (url, options) => {
    if (!String(url).startsWith('https://api.dhan.co/')) return realFetch(url, options);
    if (String(url).endsWith('/profile')) return Response.json({ dhanClientId: '1100000001' });
    if (String(url).endsWith('/trades'))
      return Response.json([fill('T1', 'BUY', 3400), fill('T2', 'SELL', 3410)]);
    return Response.json([]);
  });
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

async function optedInMember() {
  const { user, password } = await createMember();
  const session = await signIn(app, { email: 'member@example.com', password });
  const put = (path, body) => session.agent.put(path).set('X-CSRF-Token', session.csrf).send(body);
  const connected = await session.agent
    .post('/api/dhan/connect')
    .set('X-CSRF-Token', session.csrf)
    .send({ accessToken: dhanToken });
  expect(connected.status).toBe(200);
  await TelegramLink.create({ userId: user._id, chatId: '777', username: '@trader' });
  const saved = await put('/api/account/notifications', { dailyAutoImport: true });
  expect(saved.body).toMatchObject({ dailyAutoImport: true });
  return session;
}

describe('daily automatic journal', () => {
  it('adds today’s fills once after the close and sends the day’s summary', async () => {
    const session = await optedInMember();

    expect(await runDailyImports()).toMatchObject({ ran: true, date: '2026-10-16', done: 1 });
    const { trades } = (await session.agent.get('/api/workspace')).body;
    expect(trades).toEqual([
      expect.objectContaining({ symbol: 'TCS', date: '2026-10-16', quantity: 4, grossPnl: 40 }),
    ]);
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]).toMatchObject({ chatId: '777' });
    expect(telegram.sent[0].text).toContain('Dhan: added 1 round trips.');
    expect(telegram.sent[0].text).toContain('Today (2026-10-16): 1 trades');

    // Already done for today: nothing more is added or sent.
    expect(await runDailyImports()).toMatchObject({ ran: true, done: 0 });
    expect((await session.agent.get('/api/workspace')).body.trades).toHaveLength(1);
    expect(telegram.sent).toHaveLength(1);
  });

  it('waits for the close and skips weekends and holidays', async () => {
    await optedInMember();
    expect(await runDailyImports({ now: new Date('2026-10-16T09:00:00Z') })).toMatchObject({
      ran: false,
      reason: 'the market has not closed yet',
    });
    expect(await runDailyImports({ now: new Date('2026-10-18T11:00:00Z') })).toMatchObject({
      ran: false,
      reason: 'not a trading day',
    });
    expect(await runDailyImports({ now: new Date('2026-10-20T11:00:00Z') })).toMatchObject({
      ran: false,
    });
    expect(telegram.sent).toEqual([]);
  });

  it('needs the cron secret', async () => {
    expect((await supertest(app).post('/api/maintenance/daily-import')).status).toBe(401);
  });
});
