// @vitest-environment node
// Pre-market plan on Telegram: content from the member's own journal, AI focus points through the
// service layer, once per member per trading day, and only before the open.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const telegram = vi.hoisted(() => ({ sent: [] }));
vi.mock('../../services/telegram/api.js', async (original) => ({
  ...(await original()),
  sendTelegramMessage: async (chatId, text) => {
    telegram.sent.push({ chatId: String(chatId), text });
  },
}));
const ai = vi.hoisted(() => ({ calls: [], fail: false }));
vi.mock('../../services/ai/openai.js', async (original) => ({
  ...(await original()),
  structured: async (options) => {
    ai.calls.push(options);
    if (ai.fail) throw new Error('provider down');
    return {
      data: {
        focus: [
          'Set the stop before entering.',
          'Two trades, then review.',
          'Skip the first five minutes.',
          'Log every trade with a reason.',
        ],
      },
      sources: [],
    };
  },
}));

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const supertest = (await import('supertest')).default;
const { AccountSettings, AiUsageEvent, TelegramLink } = await import('../../models/index.js');
const { addToWatchlist, createRule, createTrade, saveAccountSettings } =
  await import('../../services/journal/workspace.js');
const { runPremarketPlans } = await import('../../services/ai/premarket-plan.js');

// Monday 19 Oct 2026, 08:45 IST.
const BEFORE_OPEN = new Date('2026-10-19T03:15:00Z');
const TELEGRAM_ENV = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_BOT_USERNAME: 'blank_test_bot',
  TELEGRAM_WEBHOOK_SECRET: 'z'.repeat(40),
};

let app;
beforeAll(async () => {
  Object.assign(process.env, TELEGRAM_ENV);
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of [...Object.keys(TELEGRAM_ENV), 'OPENAI_API_KEY']) delete process.env[key];
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  process.env.OPENAI_API_KEY = 'sk-test';
  telegram.sent = [];
  ai.calls = [];
  ai.fail = false;
});

async function optedInMember() {
  const { user, password } = await createMember();
  const session = await signIn(app, { email: 'member@example.com', password });
  const userId = user._id;
  await TelegramLink.create({ userId, chatId: '777', username: '@trader' });
  await addToWatchlist(userId, 'TCS');
  await addToWatchlist(userId, 'INFY');
  await createRule(userId, { section: 'Risk', rule: 'Use a stop on every trade' });
  const base = { symbol: 'TCS', type: 'Long', entryPrice: 100, quantity: 10 };
  await createTrade(userId, { ...base, date: '2026-10-16', exitPrice: 102 });
  await createTrade(userId, {
    ...base,
    date: '2026-10-16',
    exitPrice: 99,
    mistakeTags: ['Moved stop'],
  });
  await createTrade(userId, {
    ...base,
    date: '2026-10-14',
    exitPrice: 98,
    mistakeTags: ['Moved stop'],
  });
  await saveAccountSettings(userId, { riskLimits: { dailyLossLimit: 5000, maxTradesPerDay: 4 } });
  const saved = await session.agent
    .put('/api/account/notifications')
    .set('X-CSRF-Token', session.csrf)
    .send({ premarketPlan: true });
  expect(saved.body).toMatchObject({ premarketPlan: true, dailyAutoImport: false });
  expect((await session.agent.get('/api/account/notifications')).body.premarketPlan).toBe(true);
  return userId;
}

describe('pre-market plan', () => {
  it('sends one plan per day from the journal with AI focus points', async () => {
    const userId = await optedInMember();

    expect(await runPremarketPlans({ now: BEFORE_OPEN })).toMatchObject({
      ran: true,
      date: '2026-10-19',
      done: 1,
    });
    expect(telegram.sent).toHaveLength(1);
    const { chatId, text } = telegram.sent[0];
    expect(chatId).toBe('777');
    expect(text).toContain('Pre-market plan for 2026-10-19');
    expect(text).toContain('Watchlist: TCS, INFY');
    expect(text).toContain('Last session (2026-10-16): 2 trades');
    expect(text).toContain('Top mistakes (30 days): Moved stop ×2');
    expect(text).toContain('- Use a stop on every trade');
    expect(text).toContain('stop for the day at -₹5,000 · at most 4 trades');
    expect(text).toContain('- Set the stop before entering.');
    expect(text).toContain('Not investment advice');

    // The AI goes through the usage-limited service layer, with the facts only.
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]).toMatchObject({ feature: 'premarket_plan', userId });
    expect(ai.calls[0].input).toContain('Watchlist: TCS, INFY');

    // Already sent today.
    expect(await runPremarketPlans({ now: BEFORE_OPEN })).toMatchObject({ ran: true, done: 0 });
    expect(telegram.sent).toHaveLength(1);
    expect((await AccountSettings.findById(userId).lean()).premarketPlanFor).toBe('2026-10-19');
  });

  it('still sends the plan without AI bullets when AI is not configured or fails', async () => {
    await optedInMember();
    delete process.env.OPENAI_API_KEY;
    await runPremarketPlans({ now: BEFORE_OPEN });
    expect(ai.calls).toHaveLength(0);
    expect(telegram.sent[0].text).toContain('Watchlist: TCS, INFY');
    expect(telegram.sent[0].text).not.toContain('Focus today:');

    process.env.OPENAI_API_KEY = 'sk-test';
    ai.fail = true;
    await runPremarketPlans({ now: new Date('2026-10-21T03:15:00Z') });
    expect(ai.calls).toHaveLength(1);
    expect(telegram.sent).toHaveLength(2);
    expect(telegram.sent[1].text).not.toContain('Focus today:');
  });

  it('respects the hourly AI limit and still sends the plan', async () => {
    const userId = await optedInMember();
    process.env.AI_REQUESTS_PER_HOUR = '1';
    try {
      await AiUsageEvent.create({ userId, feature: 'chat', model: 'm', status: 'completed' });
      await runPremarketPlans({ now: BEFORE_OPEN });
    } finally {
      delete process.env.AI_REQUESTS_PER_HOUR;
    }
    expect(ai.calls).toHaveLength(0);
    expect(telegram.sent).toHaveLength(1);
  });

  it('skips weekends, holidays, after the open and members without Telegram', async () => {
    const userId = await optedInMember();
    expect(await runPremarketPlans({ now: new Date('2026-10-18T03:15:00Z') })).toMatchObject({
      ran: false,
      reason: 'not a trading day',
    });
    expect(await runPremarketPlans({ now: new Date('2026-10-20T03:15:00Z') })).toMatchObject({
      ran: false,
      reason: 'not a trading day',
    });
    expect(await runPremarketPlans({ now: new Date('2026-10-19T03:45:00Z') })).toMatchObject({
      ran: false,
      reason: 'the market has already opened',
    });
    await TelegramLink.deleteMany({ userId });
    expect(await runPremarketPlans({ now: BEFORE_OPEN })).toMatchObject({ done: 0, skipped: 1 });
    expect(telegram.sent).toEqual([]);
    expect(ai.calls).toEqual([]);
  });

  it('needs the cron secret', async () => {
    expect((await supertest(app).post('/api/maintenance/premarket-plan')).status).toBe(401);
  });
});
