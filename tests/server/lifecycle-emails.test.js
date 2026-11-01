// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMember,
  request,
  resetDatabase,
  signIn,
  signInAdmin,
  startTestApp,
  stopTestApp,
} from '../helpers/app.js';
import {
  AccountSettings,
  Announcement,
  PlatformSetting,
  Subscription,
  User,
} from '../../models/index.js';
import { setMailTransport } from '../../services/mailer.js';
import { forgetPlanCache } from '../../services/billing/plan.js';
import {
  sendPremiumEndedEmails,
  sendTrialEndedEmails,
} from '../../services/notifications/emails.js';
import { unsubscribeToken } from '../../services/notifications/unsubscribe.js';
import { resumeAnnouncements } from '../../services/admin/announcements.js';
import { lastCompletedWeek, sendWeeklyReport } from '../../services/journal/weekly-report.js';

const DAY = 86_400_000;
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const FIREFOX_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:131.0) Gecko/20100101 Firefox/131.0';

let app;
let mails;
beforeAll(async () => {
  Object.assign(process.env, {
    APP_URL: 'http://blank.test',
    SMTP_HOST: 'smtp.test',
    SMTP_FROM: 'Blank <no-reply@blank.test>',
  });
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of ['APP_URL', 'SMTP_HOST', 'SMTP_FROM']) delete process.env[key];
  setMailTransport(null);
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  forgetPlanCache();
  mails = [];
  setMailTransport({ sendMail: async (message) => mails.push(message) });
});

describe('lifecycle emails', () => {
  it('confirms a problem report to the member who sent it', async () => {
    const { user, password } = await createMember();
    const session = await signIn(app, { email: user.email, password });
    const sent = await session.agent
      .post('/api/account/problem-report')
      .set('X-CSRF-Token', session.csrf)
      .send({ category: 'data', message: 'The weekly P&L does not match my contract note.' });
    expect(sent.status).toBe(201);
    const confirmation = mails.find((mail) => mail.to === user.email);
    expect(confirmation.subject).toBe('We received your problem report');
    expect(confirmation.text).toContain('> The weekly P&L does not match my contract note.');
    expect(confirmation.text).toContain('Topic: Wrong numbers or data');
  });

  it('emails a sign-in from a new device, but not the first sign-in or a known device', async () => {
    const { user, password } = await createMember();
    const login = async (userAgent) => {
      const agent = request.agent(app);
      const page = await agent.get('/login');
      const csrf = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
      const response = await agent
        .post('/auth/login')
        .set('User-Agent', userAgent)
        .set('X-CSRF-Token', csrf)
        .send({ identifier: user.email, password });
      expect(response.status).toBe(200);
    };
    await login(CHROME_WINDOWS);
    await login(CHROME_WINDOWS);
    await login(FIREFOX_MAC);
    await vi.waitFor(() => expect(mails).toHaveLength(1));
    expect(mails[0]).toMatchObject({
      to: user.email,
      subject: 'New sign-in to your Pirento Blank account',
    });
    expect(mails[0].text).toContain('Device: Firefox on macOS');
    expect(mails[0].text).toMatch(/When: .+ IST/);
    expect(mails[0].text).toContain('Reset password: http://blank.test/login?mode=reset');
    const stored = await User.findById(user._id, { knownDevices: 1 }).lean();
    expect(stored.knownDevices).toHaveLength(2);
    // Only hashes are stored, never the device label itself.
    expect(stored.knownDevices.join()).not.toMatch(/Firefox|Chrome/);
  });

  it('tells a member when access is paused (once) and when it is back', async () => {
    const admin = await createMember({ email: 'admin@example.com', role: 'admin' });
    const session = await signInAdmin(app, admin.user);
    const member = await createMember();
    const post = (path) =>
      session.agent
        .post(path)
        .set('X-CSRF-Token', session.csrf)
        .send({ email: member.user.email, userId: member.user._id });
    const before = mails.length;
    expect((await post('/api/admin/users/revoke')).status).toBe(200);
    await vi.waitFor(() =>
      expect(mails.at(-1)?.subject).toBe('Your Pirento Blank access has been paused'),
    );
    expect(mails.at(-1).to).toBe(member.user.email);
    // A repeated revoke does not email again.
    expect((await post('/api/admin/users/revoke')).status).toBe(200);
    expect((await post('/api/admin/users/restore')).status).toBe(200);
    await vi.waitFor(() => expect(mails.at(-1)?.subject).toBe('Your Pirento Blank access is back'));
    expect(mails.at(-1).text).toContain('Sign in: http://blank.test/login');
    expect(mails.length - before).toBe(2);
  });

  it('emails an ended trial and an ended Premium once each from the daily job', async () => {
    await PlatformSetting.create({ _id: 'billing.plan', value: { enabled: true, trialDays: 14 } });
    const now = new Date();
    const at = (days) => new Date(now.getTime() + days * DAY);
    const member = async (email, sub) => {
      const { user } = await createMember({ email });
      await Subscription.create({ _id: user._id, ...sub });
      return user;
    };
    await member('trial@example.com', { trialEndsAt: at(-1) });
    await member('subscribed@example.com', {
      trialEndsAt: at(-1),
      paidUntil: at(20),
      razorpayStatus: 'active',
    });
    await member('long-ago@example.com', { trialEndsAt: at(-10) });
    const cancelled = await member('cancelled@example.com', {
      paidUntil: at(-1),
      razorpayStatus: 'cancelled',
      cancelAtPeriodEnd: true,
    });
    await member('renewing@example.com', { paidUntil: at(-1), razorpayStatus: 'active' });

    expect(await sendTrialEndedEmails(now)).toBe(1);
    expect(await sendTrialEndedEmails(now)).toBe(0);
    expect(mails.at(-1)).toMatchObject({
      to: 'trial@example.com',
      subject: 'Your Premium trial has ended',
    });
    expect(mails.at(-1).text).toContain('Subscribe: http://blank.test/billing');

    expect(await sendPremiumEndedEmails(now)).toBe(1);
    expect(await sendPremiumEndedEmails(now)).toBe(0);
    expect(mails.at(-1)).toMatchObject({
      to: 'cancelled@example.com',
      subject: 'Your Premium has ended',
    });
    // A later paid period that also ends gets its own notice.
    await Subscription.updateOne({ _id: cancelled._id }, { $set: { paidUntil: at(-0.5) } });
    expect(await sendPremiumEndedEmails(now)).toBe(1);
    expect(mails).toHaveLength(3);
  });
});

describe('one-click unsubscribe', () => {
  it('accepts only a genuine token and turns the list off without a session or CSRF token', async () => {
    const { user } = await createMember();
    const token = unsubscribeToken(user._id, 'announcements');
    const forged = token.replace('.announcements.', '.weekly.');
    for (const bad of ['', 'nonsense', forged, `${token.slice(0, -1)}A`]) {
      expect((await request(app).get(`/email/unsubscribe?t=${bad}`)).status).toBe(400);
      expect((await request(app).post(`/email/unsubscribe?t=${bad}`)).status).toBe(400);
    }
    // Opening the link only asks; mail scanners must not unsubscribe anyone.
    const page = await request(app).get(`/email/unsubscribe?t=${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('method="post"');
    expect(await AccountSettings.findById(user._id).lean()).toBeNull();

    // The mail provider's one-click POST (RFC 8058).
    const oneClick = await request(app)
      .post(`/email/unsubscribe?t=${token}`)
      .type('form')
      .send('List-Unsubscribe=One-Click');
    expect(oneClick.status).toBe(200);
    expect((await AccountSettings.findById(user._id).lean()).announcementEmails).toBe(false);

    // The confirmation page's own form sends the token in the body.
    await AccountSettings.updateOne({ _id: user._id }, { $set: { weeklyReportEmail: true } });
    const form = await request(app)
      .post('/email/unsubscribe')
      .type('form')
      .send({ t: unsubscribeToken(user._id, 'weekly') });
    expect(form.status).toBe(200);
    expect((await AccountSettings.findById(user._id).lean()).weeklyReportEmail).toBe(false);

    // A genuine token for an account that no longer exists answers the same and stores nothing.
    const gone = randomUUID();
    const answer = await request(app).post(
      `/email/unsubscribe?t=${unsubscribeToken(gone, 'weekly')}`,
    );
    expect(answer.status).toBe(200);
    expect(await AccountSettings.findById(gone).lean()).toBeNull();
  });

  it('puts the unsubscribe link and List-Unsubscribe headers on newsletters and weekly reports', async () => {
    const { user } = await createMember();
    await Announcement.create({
      subject: 'Monthly newsletter',
      body: 'Hello',
      audience: 'all',
      createdBy: 'admin',
      leaseUntil: new Date(Date.now() - 1000),
    });
    await resumeAnnouncements();
    await sendWeeklyReport(user, lastCompletedWeek());
    expect(mails).toHaveLength(2);
    for (const [mail, list] of [
      [mails[0], 'announcements'],
      [mails[1], 'weekly'],
    ]) {
      const url = `http://blank.test/email/unsubscribe?t=${unsubscribeToken(user._id, list)}`;
      expect(mail.headers).toEqual({
        'List-Unsubscribe': `<${url}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });
      expect(mail.text.trim().endsWith(`Unsubscribe: ${url}`)).toBe(true);
      expect(mail.html).not.toContain('Unsubscribe&nbsp;&rarr;');
    }
  });
});
