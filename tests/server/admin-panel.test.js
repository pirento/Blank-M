// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const supertest = (await import('supertest')).default;
const { AdminAuditLog, AllowedUser, Payment, PlatformSetting, User } =
  await import('../../models/index.js');
const { currentStep, totpCode } = await import('../../services/auth/totp.js');
const { forgetPlanCache } = await import('../../services/billing/plan.js');
const { applyPlatformSettings } = await import('../../services/platform/settings.js');
const { setMailTransport } = await import('../../services/mailer.js');

const WEBHOOK_SECRET = 'whsec_test_secret_value';
const realFetch = globalThis.fetch;
let app;
let mails;
let razorpay;

beforeAll(async () => {
  Object.assign(process.env, {
    BROKER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
    APP_URL: 'http://blank.test',
    SMTP_HOST: 'smtp.test',
    SMTP_FROM: 'Blank <no-reply@blank.test>',
  });
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of ['APP_URL', 'SMTP_HOST', 'SMTP_FROM', 'KITE_API_KEY', 'OPENAI_API_KEY'])
    delete process.env[key];
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  await applyPlatformSettings();
  forgetPlanCache();
  mails = [];
  setMailTransport({ sendMail: async (message) => mails.push(message) });
  razorpay = { calls: [] };
  // Only Razorpay is faked; supertest's own requests go through.
  globalThis.fetch = vi.fn(async (url, options) => {
    if (!String(url).startsWith('https://api.razorpay.com/')) return realFetch(url, options);
    const path = String(url).replace('https://api.razorpay.com/v1', '');
    razorpay.calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === '/plans') return Response.json({ id: 'plan_test1' });
    if (path === '/subscriptions') {
      return Response.json({
        id: 'sub_test1',
        short_url: 'https://rzp.io/i/pay',
        status: 'created',
      });
    }
    return Response.json({ error: { description: 'not faked' } }, { status: 400 });
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** An administrator signed in at the admin panel, optionally with a verified authenticator. */
async function adminSession({ mfa = true } = {}) {
  const created = await createMember({ email: 'admin@example.com', role: 'admin' });
  const session = await signIn(app, { email: 'admin@example.com', password: created.password });
  const send = (method, path, body) =>
    session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body);
  if (mfa) {
    const enrol = await send('post', '/auth/mfa/enroll', {});
    await send('post', '/auth/mfa/verify', {
      factorId: enrol.body.id,
      code: totpCode(enrol.body.secret, currentStep()),
    });
  }
  return { ...session, send };
}

async function memberSession() {
  const created = await createMember({ email: 'member@example.com' });
  const session = await signIn(app, { email: 'member@example.com', password: created.password });
  return {
    ...session,
    userId: created.user._id,
    send: (method, path, body) =>
      session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body),
  };
}

function signedWebhook(body, eventId) {
  const raw = JSON.stringify(body);
  return supertest(app)
    .post('/api/billing/razorpay/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Event-Id', eventId)
    .set('X-Razorpay-Signature', createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'))
    .send(raw);
}

describe('admin panel', () => {
  it('has its own sign-in that only administrators pass', async () => {
    const member = await createMember({ email: 'member@example.com' });
    const page = await supertest(app).get('/admin/login');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Administrator sign-in');
    expect((await supertest(app).get('/admin')).headers.location).toBe('/admin/login');

    const agent = supertest.agent(app);
    const csrf = (await agent.get('/admin/login')).text.match(
      /name="csrf-token" content="([^"]+)"/,
    )[1];
    const refused = await agent
      .post('/auth/admin/login')
      .set('X-CSRF-Token', csrf)
      .send({ identifier: 'member@example.com', password: member.password });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe('That username or email and password are not recognised.');

    const admin = await adminSession({ mfa: false });
    const overview = await admin.agent.get('/api/admin/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.members.total).toBe(2);
    expect((await admin.agent.get('/admin/integrations')).status).toBe(200);
  });

  it('saves API keys encrypted, applies them at once and never returns secrets', async () => {
    process.env.KITE_API_KEY = 'from-env-file';
    const withoutMfa = await adminSession({ mfa: false });
    const blocked = await withoutMfa.send('put', '/api/admin/settings', {
      changes: { KITE_API_KEY: 'x' },
    });
    expect(blocked.status).toBe(403);
    await resetDatabase();

    const admin = await adminSession();
    const secret = 'sk-test-abcdefghijklmnopqrstuvwxyz1234';
    const saved = await admin.send('put', '/api/admin/settings', {
      changes: { KITE_API_KEY: 'from-panel', OPENAI_API_KEY: secret },
    });
    expect(saved.status).toBe(200);
    expect(process.env.KITE_API_KEY).toBe('from-panel');
    expect(process.env.OPENAI_API_KEY).toBe(secret);
    expect(JSON.stringify(saved.body)).not.toContain(secret);
    const openai = saved.body.groups
      .flatMap((group) => group.settings)
      .find((setting) => setting.key === 'OPENAI_API_KEY');
    expect(openai).toMatchObject({ source: 'panel', value: null, hint: '1234' });
    const stored = await PlatformSetting.findById('OPENAI_API_KEY').lean();
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(await AdminAuditLog.countDocuments({ action: 'setting.update' })).toBe(2);

    expect(
      (await admin.send('put', '/api/admin/settings', { changes: { MONGODB_URI: 'x' } })).status,
    ).toBe(400);
    expect(
      (await admin.send('put', '/api/admin/settings', { changes: { OPENAI_API_KEY: 'nope' } }))
        .status,
    ).toBe(400);

    // Clearing the panel value brings the .env value back.
    await admin.send('put', '/api/admin/settings', { changes: { KITE_API_KEY: '' } });
    expect(process.env.KITE_API_KEY).toBe('from-env-file');
    await admin.send('put', '/api/admin/settings', { changes: { OPENAI_API_KEY: '' } });
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe('Premium', () => {
  async function billingOn(admin, plan) {
    await admin.send('put', '/api/admin/settings', {
      changes: {
        RAZORPAY_KEY_ID: 'rzp_test_abcdefgh123',
        RAZORPAY_KEY_SECRET: 'secret-value',
        RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
    });
    const saved = await admin.send('put', '/api/admin/billing', { enabled: true, ...plan });
    expect(saved.status).toBe(200);
    forgetPlanCache();
  }

  it('cannot be switched on before payments are set up', async () => {
    const admin = await adminSession();
    const refused = await admin.send('put', '/api/admin/billing', { enabled: true });
    expect(refused.status).toBe(409);
  });

  it('puts chosen features behind Premium and lets the admin grant days', async () => {
    const admin = await adminSession();
    await billingOn(admin, { trialDays: 0, features: ['paper', 'backtest'] });
    const member = await memberSession();

    const status = (await member.agent.get('/api/billing')).body;
    expect(status.membership).toMatchObject({ premium: false, state: 'free' });
    const blocked = await member.send('post', '/api/paper', {});
    expect(blocked.status).toBe(402);
    expect(blocked.body).toMatchObject({ code: 'premium_required', feature: 'paper' });
    const page = await member.agent.get('/backtest');
    expect(page.status).toBe(402);
    expect(page.text).toContain('is part of Premium');
    // Free features stay open.
    expect((await member.agent.get('/journal')).status).toBe(200);

    const granted = await admin.send('post', `/api/admin/members/${member.userId}/premium`, {
      days: 7,
    });
    expect(granted.body.membership).toMatchObject({ premium: true, state: 'granted' });
    expect((await member.send('post', '/api/paper', {})).status).not.toBe(402);
    expect((await member.agent.get('/backtest')).status).toBe(200);
  });

  it('starts checkout on Razorpay and activates Premium from a signed webhook', async () => {
    const admin = await adminSession();
    await billingOn(admin, { trialDays: 14, priceMonthly: 499 });
    const member = await memberSession();
    expect((await member.agent.get('/api/billing')).body.membership.state).toBe('trial');

    const checkout = await member.send('post', '/api/billing/checkout', {});
    expect(checkout.body).toEqual({ url: 'https://rzp.io/i/pay' });
    expect(razorpay.calls.map((call) => call.path)).toEqual(['/plans', '/subscriptions']);
    expect(razorpay.calls[0].body.item).toMatchObject({ amount: 49900, currency: 'INR' });
    // The first charge waits for the end of the trial.
    expect(razorpay.calls[1].body.start_at).toBeGreaterThan(Date.now() / 1000 + 13 * 86400);
    // Opening checkout again reuses the unpaid subscription.
    expect((await member.send('post', '/api/billing/checkout', {})).body.url).toBe(
      'https://rzp.io/i/pay',
    );
    expect(razorpay.calls).toHaveLength(2);

    const paidUntil = Math.floor(Date.now() / 1000) + 30 * 86400;
    const event = {
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: { id: 'sub_test1', status: 'active', current_end: paidUntil, paid_count: 1 },
        },
        payment: {
          entity: {
            id: 'pay_1',
            amount: 49900,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
            created_at: Math.floor(Date.now() / 1000),
          },
        },
      },
    };
    const forged = await supertest(app)
      .post('/api/billing/razorpay/webhook')
      .set('X-Razorpay-Signature', 'f'.repeat(64))
      .send(event);
    expect(forged.status).toBe(400);
    expect((await signedWebhook(event, 'evt_1')).body).toEqual({ ok: true });
    expect((await signedWebhook(event, 'evt_1')).body).toEqual({ ok: true, duplicate: true });

    const after = (await member.agent.get('/api/billing')).body;
    expect(after.membership).toMatchObject({ premium: true, razorpayStatus: 'active' });
    expect(after.payments).toEqual([expect.objectContaining({ amount: 499, status: 'captured' })]);
    expect(await Payment.countDocuments()).toBe(1);
    const overview = (await admin.agent.get('/api/admin/overview')).body;
    expect(overview.billing).toMatchObject({ revenue30d: 499, payments30d: 1 });
  });
});

describe('Premium webhooks and checkout edge cases', () => {
  async function payingMember() {
    const admin = await adminSession();
    await admin.send('put', '/api/admin/settings', {
      changes: {
        RAZORPAY_KEY_ID: 'rzp_test_abcdefgh123',
        RAZORPAY_KEY_SECRET: 'secret-value',
        RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
    });
    await admin.send('put', '/api/admin/billing', { enabled: true, trialDays: 0 });
    forgetPlanCache();
    const member = await memberSession();
    // Two quick clicks create one Razorpay subscription only.
    const [first, second] = await Promise.all([
      member.send('post', '/api/billing/checkout', {}),
      member.send('post', '/api/billing/checkout', {}),
    ]);
    // The slower click either waits (409) or gets the same payment page back.
    for (const response of [first, second]) {
      if (response.status === 200) expect(response.body.url).toBe('https://rzp.io/i/pay');
      else expect(response.status).toBe(409);
    }
    expect(razorpay.calls.filter((call) => call.path === '/subscriptions')).toHaveLength(1);
    return { admin, member };
  }
  const entity = (status, endDays, paidCount = 1) => ({
    event: `subscription.${status}`,
    payload: {
      subscription: {
        entity: {
          id: 'sub_test1',
          status,
          current_end: Math.floor(Date.now() / 1000) + endDays * 86400,
          paid_count: paidCount,
        },
      },
    },
  });
  const paidUntil = async (member) =>
    Date.parse((await member.agent.get('/api/billing')).body.membership.paidUntil);

  it('never extends Premium for an unpaid cycle or moves it backwards', async () => {
    const { member } = await payingMember();
    await signedWebhook(entity('active', 30), 'evt_a');
    const paid = await paidUntil(member);
    // A failed renewal carries the next cycle: no free month.
    await signedWebhook(entity('pending', 60), 'evt_b');
    expect(await paidUntil(member)).toBe(paid);
    // A late retry of an older cycle does not shorten Premium.
    await signedWebhook(entity('active', 5), 'evt_c');
    expect(await paidUntil(member)).toBe(paid);
    // Once cancelled, a late "active" does not bring renewal back.
    await signedWebhook(entity('cancelled', 30), 'evt_d');
    await signedWebhook(entity('active', 30), 'evt_e');
    const after = (await member.agent.get('/api/billing')).body.membership;
    expect(after).toMatchObject({ razorpayStatus: 'cancelled', cancelAtPeriodEnd: true });
  });

  it('needs the webhook secret to switch billing on and an authenticator to invite admins', async () => {
    const admin = await adminSession();
    await admin.send('put', '/api/admin/settings', {
      changes: { RAZORPAY_KEY_ID: 'rzp_test_abcdefgh123', RAZORPAY_KEY_SECRET: 'secret-value' },
    });
    const refused = await admin.send('put', '/api/admin/billing', { enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/webhook secret/);

    await resetDatabase();
    const plain = await adminSession({ mfa: false });
    const invite = await plain.send('post', '/api/admin/users/invite', {
      email: 'boss@example.com',
      role: 'admin',
    });
    expect(invite.status).toBe(403);
    expect(invite.body.error).toMatch(/authenticator/);
  });
});

describe('sign-up', () => {
  it('is closed until the administrator opens it, then emails an activation link', async () => {
    const visitor = supertest.agent(app);
    const csrf = (await visitor.get('/login')).text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const send = (email) => visitor.post('/auth/signup').set('X-CSRF-Token', csrf).send({ email });
    const closed = await send('new@example.com');
    expect(closed.status).toBe(403);
    expect(closed.body.error).toMatch(/Sign-up is closed/);
    expect((await supertest(app).get('/signup')).headers.location).toBe('/login');

    const admin = await adminSession();
    await admin.send('put', '/api/admin/billing', { signupOpen: true });
    forgetPlanCache();
    expect((await supertest(app).get('/signup')).status).toBe(200);
    expect((await supertest(app).get('/login')).text).toContain('Create an account');

    expect((await send('New@Example.com')).body).toEqual({ ok: true });
    const user = await User.findOne({ email: 'new@example.com' }).lean();
    expect(user).toMatchObject({ role: 'member', emailConfirmedAt: null });
    expect(await AllowedUser.exists({ _id: 'new@example.com' })).toBeTruthy();
    expect(mails.at(-1)).toMatchObject({
      to: 'new@example.com',
      subject: 'Confirm your Pirento Blank account',
    });

    // An existing member gets the same answer and no email.
    const before = mails.length;
    expect((await send('admin@example.com')).body).toEqual({ ok: true });
    expect(mails).toHaveLength(before);
    expect((await send('not-an-email')).status).toBe(400);
  });
});
