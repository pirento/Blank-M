// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMember,
  request,
  resetDatabase,
  signIn,
  startTestApp,
  stopTestApp,
} from '../helpers/app.js';
import { setMailTransport } from '../../services/mailer.js';
import { lastCompletedWeek } from '../../services/journal/weekly-report.js';

const SECRET = 'cron-secret-for-tests-0123456789abcdef';
const sent = [];
let app;
beforeAll(async () => {
  process.env.SMTP_HOST = 'smtp.test.invalid';
  process.env.SMTP_FROM = 'Blank <reports@test.invalid>';
  process.env.CRON_SECRET = SECRET;
  process.env.APP_URL = 'http://localhost:3000';
  setMailTransport({ sendMail: async (message) => sent.push(message) });
  app = await startTestApp();
});
afterAll(async () => {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  setMailTransport(null);
  await stopTestApp();
});
beforeEach(async () => {
  sent.length = 0;
  await resetDatabase();
});

async function member(email) {
  const created = await createMember({ email });
  const session = await signIn(app, { email, password: created.password });
  return {
    ...session,
    send: (method, path, body) =>
      session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body),
  };
}

describe('weekly report emails', () => {
  it('computes the last complete Monday–Sunday week', () => {
    expect(lastCompletedWeek('2026-10-12')).toMatchObject({
      start: '2026-10-05',
      end: '2026-10-11',
    });
    expect(lastCompletedWeek('2026-10-18')).toMatchObject({
      start: '2026-10-05',
      end: '2026-10-11',
    });
  });

  it('sends once per week to members who opted in', async () => {
    const week = lastCompletedWeek();
    const keen = await member('keen@example.com');
    await member('quiet@example.com');
    await keen.send('post', '/api/trades', {
      date: week.start,
      symbol: 'INFY',
      type: 'Long',
      entryPrice: 1500,
      exitPrice: 1520,
      quantity: 10,
    });
    expect(
      (await keen.send('put', '/api/account/notifications', { weeklyReportEmail: true })).body
        .weeklyReportEmail,
    ).toBe(true);

    const run = () =>
      request(app).post('/api/maintenance/weekly-reports').set('Authorization', `Bearer ${SECRET}`);
    expect((await run()).body).toMatchObject({ sent: 1, configured: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('keen@example.com');
    expect(sent[0].text).toContain('Trades: 1');
    expect(sent[0].text).toContain('Best symbol: INFY');
    expect((await run()).body).toMatchObject({ sent: 0 });
    expect(sent).toHaveLength(1);
  });

  it('requires the maintenance secret', async () => {
    expect((await request(app).post('/api/maintenance/weekly-reports')).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/maintenance/weekly-reports')
          .set('Authorization', 'Bearer wrong')
      ).status,
    ).toBe(401);
  });

  it('sends the signed-in member their report on request', async () => {
    const account = await member('now@example.com');
    const response = await account.send('post', '/api/account/weekly-report/send', {});
    expect(response.status).toBe(200);
    expect(sent[0]).toMatchObject({ to: 'now@example.com' });
    expect(sent[0].text).toContain('No journal trades were recorded this week.');
  });
});
