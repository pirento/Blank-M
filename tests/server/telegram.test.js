// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const telegram = vi.hoisted(() => ({ sent: [] }));
vi.mock('../../services/telegram/api.js', async (original) => ({
  ...(await original()),
  sendTelegramMessage: async (chatId, text) => {
    telegram.sent.push({ chatId: String(chatId), text });
  },
}));
const market = vi.hoisted(() => ({ prices: { INFY: 1500 } }));
vi.mock('../../services/market/index.js', async (original) => ({
  ...(await original()),
  getQuote: async (symbol) => ({ price: market.prices[symbol] }),
}));

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const supertest = (await import('supertest')).default;
const { todayInIst } = await import('../../shared/market.js');

const SECRET = 'z'.repeat(40);
let app;
beforeAll(async () => {
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_BOT_USERNAME: 'blank_test_bot',
    TELEGRAM_WEBHOOK_SECRET: SECRET,
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
});

let updateId = 0;
const say = (text, chatId = 777) =>
  supertest(app)
    .post('/api/telegram/webhook')
    .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
    .send({
      update_id: (updateId += 1),
      message: {
        message_id: updateId,
        chat: { id: chatId, type: 'private' },
        from: { id: chatId, username: 'trader' },
        text,
      },
    });
const lastReply = () => telegram.sent.at(-1)?.text ?? '';

async function linkedMember() {
  const { password } = await createMember();
  const session = await signIn(app, { email: 'member@example.com', password });
  const send = (method, path, body) =>
    session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body);
  const created = await send('post', '/api/telegram/link');
  expect(created.status).toBe(201);
  const code = new URL(created.body.url).searchParams.get('start');
  expect(created.body.url).toContain('https://t.me/blank_test_bot?start=');
  await say(`/start ${code}`);
  expect(lastReply()).toContain('Linked to Blank');
  return { send, code };
}

describe('Telegram bot', () => {
  it('links a chat once with a one-time code and logs trades by command', async () => {
    const { send, code } = await linkedMember();
    expect((await send('get', '/api/telegram')).body).toMatchObject({
      linked: true,
      username: '@trader',
    });
    // The code cannot be reused, even from another chat.
    await say(`/start ${code}`, 888);
    expect(lastReply()).toContain('expired or was already used');

    await say('/log infy long 10 1500 1520 breakout held');
    expect(lastReply()).toMatch(/^Logged INFY Long 10 @ 1500 → 1520: net \+₹/);
    const ledger = await send('get', '/api/account/export');
    expect(ledger.body.trades[0]).toMatchObject({
      symbol: 'INFY',
      date: todayInIst(),
      notes: 'breakout held',
    });
    await say('/log INFY SIDEWAYS 1 1 1');
    expect(lastReply()).toBe('Direction must be LONG or SHORT.');
    await say('/log INFY');
    expect(lastReply()).toContain('Usage');
    await say('/today');
    expect(lastReply()).toContain('1 trades');
  });

  it('rejects unlinked chats and a wrong secret, and sends price alerts to the chat', async () => {
    await say('/today', 999);
    expect(lastReply()).toContain('not linked');
    // Any chat can read its own ID (for server alerts), linked or not.
    await say('/chatid', 999);
    expect(lastReply()).toBe("This chat's ID: 999");
    const forged = await supertest(app)
      .post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 'wrong')
      .send({ message: { chat: { id: 1, type: 'private' }, text: '/today' } });
    expect(forged.status).toBe(401);

    const { send } = await linkedMember();
    await send('post', '/api/alerts', { symbol: 'INFY', condition: 'above', price: 1490 });
    await send('post', '/api/alerts/check');
    expect(telegram.sent.at(-1)).toMatchObject({ chatId: '777' });
    expect(lastReply()).toContain('INFY rose to ₹1500');

    await say('/unlink');
    expect((await send('get', '/api/telegram')).body.linked).toBe(false);
  });

  it('handles a redelivered update only once', async () => {
    const { send } = await linkedMember();
    const update = {
      update_id: (updateId += 1),
      message: {
        message_id: updateId,
        chat: { id: 777, type: 'private' },
        from: { id: 777, username: 'trader' },
        text: '/log INFY LONG 10 1500 1520',
      },
    };
    const deliver = () =>
      supertest(app)
        .post('/api/telegram/webhook')
        .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
        .send(update);
    expect((await deliver()).status).toBe(200);
    expect((await deliver()).status).toBe(200);
    const ledger = await send('get', '/api/account/export');
    expect(ledger.body.trades).toHaveLength(1);
  });
});
