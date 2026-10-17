// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ai = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../services/ai/openai.js', async (original) => ({
  ...(await original()),
  structured: async (options) => {
    ai.calls.push(options);
    return {
      data: {
        summary: 'Good week; two trades broke the stop rule.',
        wentWell: ['Waited for the opening range.'],
        mistakes: [
          { pattern: 'Moved stop', evidence: 'Trade 2 on 2026-10-06', fix: 'Set it once.' },
        ],
        ruleAdherence: [{ rule: 'Use a stop on every trade', status: 'partly', note: '' }],
        disciplineScore: 6,
        focus: ['Do not move the stop.'],
      },
      sources: [],
    };
  },
}));

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const { setMailTransport } = await import('../../services/mailer.js');
const { sendWeeklyReport } = await import('../../services/journal/weekly-report.js');
const { User } = await import('../../models/index.js');

const mails = [];
let app;
beforeAll(async () => {
  Object.assign(process.env, {
    OPENAI_API_KEY: 'sk-test',
    SMTP_HOST: 'smtp.test',
    SMTP_FROM: 'Blank <blank@example.com>',
  });
  setMailTransport({ sendMail: async (message) => mails.push(message) });
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of ['OPENAI_API_KEY', 'SMTP_HOST', 'SMTP_FROM']) delete process.env[key];
  setMailTransport(null);
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  ai.calls.length = 0;
  mails.length = 0;
});

async function member() {
  const { password, user } = await createMember();
  const session = await signIn(app, { email: 'member@example.com', password });
  const send = (method, path, body) =>
    session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body);
  return { send, userId: user._id };
}
const trade = (date, fields = {}) => ({
  date,
  symbol: 'INFY',
  type: 'Long',
  entryPrice: 100,
  exitPrice: 102,
  quantity: 10,
  ...fields,
});

describe('AI coach', () => {
  it('reviews the week from the server-side journal and saves the result', async () => {
    const { send } = await member();
    await send('post', '/api/rules', {
      section: 'Risk',
      definition: '',
      rule: 'Use a stop on every trade',
    });
    await send('post', '/api/trades', trade('2026-10-05', { setupTags: ['Breakout'] }));
    await send(
      'post',
      '/api/trades',
      trade('2026-10-06', {
        exitPrice: 97,
        mistakeTags: ['Moved stop'],
        emotion: 'fomo',
        plannedRisk: 20,
      }),
    );
    await send('post', '/api/trades', trade('2026-09-20')); // outside the week

    const response = await send('post', '/api/ai/coach-review', {
      period: 'week',
      date: '2026-10-11',
    });
    expect(response.status).toBe(201);
    expect(response.body.review).toMatchObject({
      period: 'week',
      from: '2026-10-05',
      to: '2026-10-11',
      tradeCount: 2,
      review: { disciplineScore: 6 },
    });
    const input = ai.calls[0].input;
    expect(input).toContain('Use a stop on every trade');
    expect(input).toContain('mistakes: Moved stop');
    expect(input).toMatch(/ -1\.5\d?R/); // net of charges
    expect(input).not.toContain('2026-09-20');

    const list = await send('get', '/api/ai/coach-reviews');
    expect(list.body.reviews).toHaveLength(1);
  });

  it('refuses an empty period and adds the review to the weekly email when chosen', async () => {
    const { send, userId } = await member();
    const empty = await send('post', '/api/ai/coach-review', { period: 'day', date: '2026-10-07' });
    expect(empty.status).toBe(409);
    expect(ai.calls).toHaveLength(0);

    await send('post', '/api/trades', trade('2026-10-06'));
    const toggled = await send('put', '/api/account/notifications', {
      weeklyReportEmail: true,
      weeklyAiCoach: true,
    });
    expect(toggled.body).toEqual({ weeklyReportEmail: true, weeklyAiCoach: true });
    const user = await User.findById(userId).lean();
    await sendWeeklyReport(user, { start: '2026-10-05', end: '2026-10-11', type: 'weekly' });
    expect(mails[0].text).toContain('AI coach (discipline 6/10)');
    expect(mails[0].text).toContain('- Do not move the stop.');
    // The saved review for that week is reused by a second email.
    await sendWeeklyReport(user, { start: '2026-10-05', end: '2026-10-11', type: 'weekly' });
    expect(ai.calls).toHaveLength(1);
  });
});
