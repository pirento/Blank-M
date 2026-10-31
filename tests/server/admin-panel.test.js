// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { createMember, resetDatabase, signIn, signInAdmin, startTestApp, stopTestApp } =
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
let googleProfile;

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
  // What Razorpay answers for GET /subscriptions/sub_test1 and for cancelling it.
  razorpay = {
    calls: [],
    subscription: { id: 'sub_test1', status: 'created' },
    cancel: { id: 'sub_test1', status: 'cancelled', paid_count: 1 },
  };
  // Only Razorpay is faked; supertest's own requests go through.
  globalThis.fetch = vi.fn(async (url, options) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'google-token' });
    }
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return Response.json(googleProfile);
    }
    if (!String(url).startsWith('https://api.razorpay.com/')) return realFetch(url, options);
    const path = String(url).replace('https://api.razorpay.com/v1', '');
    razorpay.calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === '/plans') return Response.json({ id: 'plan_test1' });
    if (path === '/plans?count=1') return Response.json({ items: [] });
    if (path === '/subscriptions/sub_test1/cancel') {
      return razorpay.cancel.error
        ? Response.json(razorpay.cancel, { status: 400 })
        : Response.json(razorpay.cancel);
    }
    if (path === '/subscriptions/sub_test1') return Response.json(razorpay.subscription);
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

/**
 * An administrator signed in with Google at the admin panel, optionally with a verified
 * authenticator (without one, everything but adding it is refused).
 */
async function adminSession({ mfa = true } = {}) {
  const created = await createMember({ email: 'admin@example.com', role: 'admin' });
  const session = await signInAdmin(app, created.user, { authenticator: false });
  const send = (method, path, body) =>
    session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body);
  if (mfa) {
    // An administrator's first authenticator needs the emailed setup code.
    expect((await send('post', '/auth/mfa/admin-code', {})).status).toBe(200);
    const setupCode = mails.at(-1).text.match(/\b\d{8}\b/)[0];
    const enrol = await send('post', '/auth/mfa/enroll', { setupCode });
    expect(enrol.status).toBe(201);
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
  it('lets administrators in only with Google and an authenticator', async () => {
    const member = await createMember({ email: 'member@example.com' });
    const page = await supertest(app).get('/admin/login');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Administrator sign-in');
    expect(page.text).not.toContain('type="password"');
    expect((await supertest(app).get('/admin')).headers.location).toBe('/admin/login');
    // The old password endpoint is gone.
    expect((await supertest(app).post('/auth/admin/login').send({})).status).toBeGreaterThanOrEqual(
      400,
    );

    // A member's Google account cannot use the admin sign-in.
    await expect(signInAdmin(app, member.user)).rejects.toThrow(/admin sign-in failed/);

    // An administrator's password does not work anywhere.
    const created = await createMember({ email: 'admin@example.com', role: 'admin' });
    await expect(
      signIn(app, { email: 'admin@example.com', password: created.password }),
    ).rejects.toThrow(/403/);

    // Google without an authenticator: only the "add an authenticator" screen.
    const noCode = await signInAdmin(app, created.user, { authenticator: false });
    const setup = await noCode.agent.get('/admin');
    expect(setup.status).toBe(403);
    expect(setup.text).toContain('Add an authenticator to continue');
    expect((await noCode.agent.get('/api/admin/overview')).status).toBe(403);

    const admin = await signInAdmin(app, created.user);
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

    // The older BLANK_OPENAI_API_KEY name in .env, which the AI features also read, counts as set.
    process.env.BLANK_OPENAI_API_KEY = 'sk-alias-abcdefghijklmnopqrstuvwxyz9876';
    try {
      const listed = (await admin.agent.get('/api/admin/settings')).body.groups
        .flatMap((group) => group.settings)
        .find((setting) => setting.key === 'OPENAI_API_KEY');
      expect(listed).toMatchObject({ source: 'env', value: null, hint: '9876' });
    } finally {
      delete process.env.BLANK_OPENAI_API_KEY;
    }
  });

  it('sends a test email and checks the Telegram bot from Integrations, ten tests an hour', async () => {
    const admin = await adminSession();
    const test = (name) => admin.send('post', `/api/admin/integrations/${name}`, {});
    expect((await test('test-email')).body).toEqual({ ok: true, to: 'admin@example.com' });
    expect(mails.at(-1)).toMatchObject({
      to: 'admin@example.com',
      subject: 'Pirento Blank test email',
    });

    expect((await test('telegram-check')).status).toBe(409);
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: '123:token',
      TELEGRAM_BOT_USERNAME: 'blank_bot',
      TELEGRAM_WEBHOOK_SECRET: 'w'.repeat(32),
    });
    const telegram = [];
    const fallback = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, options) => {
      if (!String(url).startsWith('https://api.telegram.org/')) return fallback(url, options);
      const method = String(url).split('/').at(-1);
      telegram.push({ method, body: JSON.parse(options.body) });
      return Response.json({
        ok: true,
        result: method === 'getMe' ? { username: 'blank_bot' } : true,
      });
    });
    try {
      expect((await test('telegram-check')).body).toEqual({ ok: true, username: 'blank_bot' });
      // Telegram only calls HTTPS webhooks.
      expect((await test('telegram-webhook')).status).toBe(409);
      process.env.APP_URL = 'https://blank.test';
      const hook = await test('telegram-webhook');
      expect(hook.body).toEqual({ ok: true, url: 'https://blank.test/api/telegram/webhook' });
      expect(telegram.at(-1)).toMatchObject({
        method: 'setWebhook',
        body: { url: 'https://blank.test/api/telegram/webhook', secret_token: 'w'.repeat(32) },
      });
      expect(await AdminAuditLog.distinct('action')).toEqual(
        expect.arrayContaining([
          'integration.telegram-check',
          'integration.telegram-webhook',
          'integration.test-email',
        ]),
      );
      // Four tests so far; six more are allowed this hour, then they are refused.
      for (let used = 4; used < 10; used += 1) expect((await test('test-email')).status).toBe(200);
      expect((await test('test-email')).status).toBe(429);
    } finally {
      process.env.APP_URL = 'http://blank.test';
      for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET'])
        delete process.env[key];
    }
  });

  it('restores a suspended member, who signs in again; an invitation goes back to invited', async () => {
    const admin = await adminSession();
    const created = await createMember({ email: 'leaver@example.com' });
    const body = { email: 'leaver@example.com', userId: created.user._id };
    const signInLeaver = () =>
      signIn(app, { email: 'leaver@example.com', password: created.password });
    expect((await admin.send('post', '/api/admin/users/restore', body)).status).toBe(409);
    expect((await admin.send('post', '/api/admin/users/revoke', body)).status).toBe(200);
    await expect(signInLeaver()).rejects.toThrow(/login failed/);

    expect((await admin.send('post', '/api/admin/users/restore', body)).body).toEqual({
      ok: true,
      status: 'active',
    });
    await signInLeaver();
    const users = (await admin.agent.get('/api/admin/users')).body.users;
    expect(users.find((user) => user.email === 'leaver@example.com')).toMatchObject({
      status: 'active',
      revokedAt: null,
      authBanPending: false,
    });
    expect(
      await AdminAuditLog.exists({ action: 'member.restore', target: body.email }),
    ).toBeTruthy();

    // A revoked invitation that was never activated can be resent once restored.
    const invite = { email: 'new@example.com' };
    expect((await admin.send('post', '/api/admin/users/invite', invite)).status).toBe(201);
    await admin.send('post', '/api/admin/users/revoke', invite);
    expect((await admin.send('post', '/api/admin/users/resend', invite)).status).toBe(409);
    expect((await admin.send('post', '/api/admin/users/restore', invite)).body).toEqual({
      ok: true,
      status: 'invited',
    });
    expect((await admin.send('post', '/api/admin/users/resend', invite)).status).toBe(200);
  });

  it('needs a one-time setup code before an administrator adds a first authenticator', async () => {
    const admin = await adminSession({ mfa: false });
    const noCode = await admin.send('post', '/auth/mfa/enroll', {});
    expect(noCode.status).toBe(403);
    expect(noCode.body.code).toBe('admin_setup_code_required');
    expect((await admin.send('post', '/auth/mfa/admin-code', {})).status).toBe(200);
    const code = mails.at(-1).text.match(/\b\d{8}\b/)[0];
    const wrong = code === '00000000' ? '00000001' : '00000000';
    expect((await admin.send('post', '/auth/mfa/enroll', { setupCode: wrong })).status).toBe(403);
    expect((await admin.send('post', '/auth/mfa/enroll', { setupCode: code })).status).toBe(201);
    // Single use.
    expect((await admin.send('post', '/auth/mfa/enroll', { setupCode: code })).status).toBe(403);

    // Members need no code.
    const member = await memberSession();
    expect((await member.send('post', '/auth/mfa/admin-code', {})).status).toBe(400);
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
    expect((await admin.send('post', '/api/admin/billing/check-keys', {})).status).toBe(409);
    await admin.send('put', '/api/admin/settings', {
      changes: { RAZORPAY_KEY_ID: 'rzp_test_abcdefgh123', RAZORPAY_KEY_SECRET: 'secret-value' },
    });
    const checked = await admin.send('post', '/api/admin/billing/check-keys', {});
    expect(checked.body).toEqual({ ok: true, mode: 'test', webhookSecretSet: false });
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

  it('counts free AI requests and free days of other features, then asks for Premium', async () => {
    const admin = await adminSession();
    await billingOn(admin, {
      trialDays: 0,
      features: ['paper', 'ai'],
      freeQuota: { paper: 1, ai: 2 },
    });
    const member = await memberSession();
    // Per day: opening the page and any number of requests today use one day.
    expect((await member.agent.get('/paper')).status).toBe(200);
    for (let use = 0; use < 3; use += 1) {
      expect((await member.send('post', '/api/paper/refresh', {})).status).not.toBe(402);
    }
    // Per request: a request that fails (here: no AI key) gives its free use back...
    const failed = await member.send('post', '/api/ai/rule', {});
    expect(failed.status).not.toBe(402);
    await vi.waitFor(async () =>
      expect((await member.agent.get('/api/billing')).body.freeUsage.ai.used).toBe(0),
    );
    // ...and each AI request that does work uses one; reading results does not.
    const { takeFreeUse } = await import('../../services/billing/usage.js');
    for (let use = 0; use < 2; use += 1) {
      expect(await takeFreeUse(member.userId, 'ai', 2)).toBe(true);
    }
    expect((await member.agent.get('/api/ai/coach-reviews')).status).toBe(402);
    const third = await member.send('post', '/api/ai/rule', {});
    expect(third.status).toBe(402);
    expect(third.body.error).toMatch(/2 free uses/);
    expect((await member.agent.get('/api/billing')).body.freeUsage).toEqual({
      paper: { used: 1, limit: 1, unit: 'days' },
      ai: { used: 2, limit: 2, unit: 'uses' },
    });
    // Parallel requests on a new day cannot slip past a used-up allowance, and many requests on
    // one day count once.
    const { takeFreeDay } = await import('../../services/billing/usage.js');
    const tomorrow = new Date(Date.now() + 86_400_000);
    const late = await Promise.all(
      Array.from({ length: 5 }, () => takeFreeDay(member.userId, 'paper', 1, tomorrow)),
    );
    expect(late.some(Boolean)).toBe(tomorrow.getMonth() !== new Date().getMonth());
    const burst = await Promise.all(
      Array.from({ length: 5 }, () => takeFreeDay('someone', 'options', 2)),
    );
    expect(burst).toEqual([true, true, true, true, true]);
    const { usedThisMonth } = await import('../../services/billing/usage.js');
    expect(await usedThisMonth('someone', 'options')).toBe(1);
    // Invalid allowances are refused.
    const bad = await admin.send('put', '/api/admin/billing', { freeQuota: { paper: -1 } });
    expect(bad.status).toBe(400);
  });

  it('gives one free trial per person, not per email alias', async () => {
    const { canonicalEmail } = await import('../../services/billing/membership.js');
    expect(canonicalEmail('A.B+promo@GoogleMail.com')).toBe('ab@gmail.com');
    expect(canonicalEmail('a.b+x@zoho.com')).toBe('a.b@zoho.com');

    const admin = await adminSession();
    await billingOn(admin, { trialDays: 14 });
    const states = [];
    for (const email of ['trader.one@gmail.com', 'traderone+2@gmail.com', 'other@gmail.com']) {
      const created = await createMember({ email });
      const session = await signIn(app, { email, password: created.password });
      states.push((await session.agent.get('/api/billing')).body.membership.state);
    }
    expect(states).toEqual(['trial', 'free', 'trial']);

    // Background jobs (weekly report, daily import) never start a dormant member's trial.
    const { hasFeature } = await import('../../services/billing/membership.js');
    const { Subscription } = await import('../../models/index.js');
    const dormant = await createMember({ email: 'dormant@example.com' });
    expect(await hasFeature(dormant.user, 'ai', { startTrial: false })).toBe(true);
    expect(await Subscription.exists({ _id: dormant.user._id })).toBeNull();
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
    // Opening checkout again reuses the unpaid subscription (after checking it is still open).
    expect((await member.send('post', '/api/billing/checkout', {})).body.url).toBe(
      'https://rzp.io/i/pay',
    );
    expect(razorpay.calls.map((call) => call.path)).toEqual([
      '/plans',
      '/subscriptions',
      '/subscriptions/sub_test1',
    ]);

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

  it('keeps a renewing member through the renewal gap, and stops billing when access is revoked', async () => {
    const { computeMembership } = await import('../../services/billing/membership.js');
    const plan = { enabled: true, features: ['paper'] };
    const member = { role: 'member' };
    const ended = new Date(Date.now() - 86_400_000);
    const renewing = { paidUntil: ended, razorpayStatus: 'active', cancelAtPeriodEnd: false };
    expect(computeMembership(plan, member, renewing).premium).toBe(true);
    expect(computeMembership(plan, member, { ...renewing, cancelAtPeriodEnd: true }).premium).toBe(
      false,
    );
    const longAgo = new Date(Date.now() - 3 * 86_400_000);
    expect(computeMembership(plan, member, { ...renewing, paidUntil: longAgo }).premium).toBe(
      false,
    );
    // Subscribed during the trial: the first charge gets the same grace after the trial ends.
    const firstCharge = { trialEndsAt: ended, razorpayStatus: 'authenticated' };
    expect(computeMembership(plan, member, firstCharge)).toMatchObject({
      premium: true,
      state: 'active',
    });
    expect(computeMembership(plan, member, { ...firstCharge, trialEndsAt: longAgo }).premium).toBe(
      false,
    );
    const inTrial = { ...firstCharge, trialEndsAt: new Date(Date.now() + 86_400_000) };
    expect(computeMembership(plan, member, inTrial).state).toBe('trial');

    const { admin, member: payer } = await payingMember();
    await signedWebhook(entity('active', 30), 'evt_a');
    const paid = await paidUntil(payer);
    // Cancelled while a charge was failing: the unpaid cycle is not a free month.
    await signedWebhook(entity('cancelled', 60), 'evt_b');
    expect(await paidUntil(payer)).toBe(paid);

    // Clearing the payment keys while billing is on would break every renewal.
    const cleared = await admin.send('put', '/api/admin/settings', {
      changes: { RAZORPAY_WEBHOOK_SECRET: '' },
    });
    expect(cleared.status).toBe(409);
  });

  it('cancels the Razorpay subscription of a member whose access is revoked', async () => {
    const { admin, member } = await payingMember();
    await signedWebhook(entity('active', 30), 'evt_a');
    const revoked = await admin.send('post', '/api/admin/users/revoke', {
      email: 'member@example.com',
      userId: member.userId,
    });
    expect(revoked.status).toBe(200);
    const cancel = razorpay.calls.find((call) => call.path === '/subscriptions/sub_test1/cancel');
    expect(cancel.body).toEqual({ cancel_at_cycle_end: 0 });
  });

  it('replaces an expired checkout, which never blocks switching billing off', async () => {
    const { admin, member } = await payingMember();
    razorpay.subscription = { id: 'sub_test1', status: 'expired' };
    const again = await member.send('post', '/api/billing/checkout', {});
    expect(again.body).toEqual({ url: 'https://rzp.io/i/pay' });
    expect(razorpay.calls.filter((call) => call.path === '/subscriptions')).toHaveLength(2);
    // The new checkout is unpaid too ('created'): it does not count as a live subscription.
    expect((await admin.send('put', '/api/admin/billing', { enabled: false })).status).toBe(200);
  });

  it('renews only once paid, and tells a member who cancelled renewal when Premium ends', async () => {
    const { Subscription } = await import('../../models/index.js');
    const { member } = await payingMember();
    const record = () => Subscription.findById(member.userId).lean();
    await signedWebhook(entity('active', 30), 'evt_a');
    expect((await record()).cancelAtPeriodEnd).toBe(false);
    // "Cancel renewal": Razorpay keeps it active until the paid month ends.
    razorpay.cancel = entity('active', 30).payload.subscription.entity;
    razorpay.subscription = razorpay.cancel;
    expect((await member.send('post', '/api/billing/cancel', {})).status).toBe(200);
    await member.send('post', '/api/billing/refresh', {});
    expect((await record()).cancelAtPeriodEnd).toBe(true);
    const refused = await member.send('post', '/api/billing/checkout', {});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/^Premium ends on .+\. You can subscribe again then\.$/);

    // Once it ends, a new checkout does not "renew" until it is paid.
    await signedWebhook(entity('completed', 0), 'evt_b');
    expect((await member.send('post', '/api/billing/checkout', {})).status).toBe(200);
    expect(await record()).toMatchObject({ razorpayStatus: 'created', cancelAtPeriodEnd: true });
    await signedWebhook(entity('active', 30), 'evt_c');
    expect((await record()).cancelAtPeriodEnd).toBe(false);
  });

  it('deletes a member whose subscription Razorpay already ended', async () => {
    const { deleteMember } = await import('../../services/admin/delete-member.js');
    await payingMember();
    razorpay.cancel = {
      error: { description: 'Subscription is not cancellable in expired status' },
    };
    // Still cancellable: deleting stops rather than leave a member being charged.
    razorpay.subscription = { id: 'sub_test1', status: 'active' };
    await expect(deleteMember('member@example.com')).rejects.toMatchObject({ status: 502 });
    razorpay.subscription = { id: 'sub_test1', status: 'expired' };
    expect(await deleteMember('member@example.com')).toMatchObject({
      email: 'member@example.com',
    });
    expect(await User.exists({ email: 'member@example.com' })).toBeNull();
  });

  it('keeps billing on while members have live subscriptions', async () => {
    const { admin } = await payingMember();
    await signedWebhook(entity('active', 30), 'evt_a');
    const refused = await admin.send('put', '/api/admin/billing', { enabled: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/live subscription/);
    await signedWebhook(entity('cancelled', 30), 'evt_b');
    expect((await admin.send('put', '/api/admin/billing', { enabled: false })).status).toBe(200);
  });

  it('needs the webhook secret to switch billing on and an authenticator to invite admins', async () => {
    const admin = await adminSession();
    await admin.send('put', '/api/admin/settings', {
      changes: { RAZORPAY_KEY_ID: 'rzp_test_abcdefgh123', RAZORPAY_KEY_SECRET: 'secret-value' },
    });
    const refused = await admin.send('put', '/api/admin/billing', { enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/webhook secret/);

    // A new administrator is told to sign in with Google; there is no password link.
    const boss = await admin.send('post', '/api/admin/users/invite', {
      email: 'boss@example.com',
      role: 'admin',
    });
    expect(boss.status).toBe(201);
    expect(mails.at(-1)).toMatchObject({ to: 'boss@example.com' });
    expect(mails.at(-1).text).toContain('/admin/login');
    expect(mails.at(-1).text).not.toContain('/auth/link/activate');

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

describe('legal pages', () => {
  it('are public and show the business details set in the admin panel', async () => {
    const admin = await adminSession();
    await admin.send('put', '/api/admin/settings', {
      changes: { BUSINESS_NAME: 'Pirento Group', SUPPORT_EMAIL: 'help@pirento.test' },
    });
    for (const path of ['/terms', '/privacy', '/disclaimer', '/refunds', '/contact']) {
      const page = await supertest(app).get(path);
      expect(page.status).toBe(200);
      expect(page.text).toContain('Pirento Group');
    }
    expect((await supertest(app).get('/contact')).text).toContain('help@pirento.test');
    expect(
      (await admin.send('put', '/api/admin/settings', { changes: { SUPPORT_EMAIL: 'nope' } }))
        .status,
    ).toBe(400);
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
    // The email goes out in the background, so the answer is as fast for known addresses.
    await vi.waitFor(() => expect(mails.at(-1)?.to).toBe('new@example.com'));
    expect(mails.at(-1)).toMatchObject({
      to: 'new@example.com',
      subject: 'Confirm your Pirento Blank account',
    });

    // An existing member gets the same answer and no email.
    const before = mails.length;
    expect((await send('admin@example.com')).body).toEqual({ ok: true });
    expect(mails).toHaveLength(before);
    expect((await send('not-an-email')).status).toBe(400);

    // Never confirmed: removed after 7 days, once the link has expired; activated members stay.
    const { deleteUnconfirmedSignups } = await import('../../services/auth/accounts.js');
    const invited = await createMember({ email: 'invited@example.com' });
    await User.updateOne({ _id: invited.user._id }, { $set: { emailConfirmedAt: null } });
    await AllowedUser.updateMany(
      {},
      { $set: { invitedAt: new Date(Date.now() - 8 * 86_400_000) } },
    );
    expect(await deleteUnconfirmedSignups()).toBe(0); // the activation link is still valid
    const later = new Date(Date.now() + 2 * 86_400_000);
    expect(await deleteUnconfirmedSignups({ now: later })).toBe(1);
    expect(await User.exists({ email: 'new@example.com' })).toBeNull();
    expect(await AllowedUser.exists({ _id: 'new@example.com' })).toBeNull();
    expect(await User.exists({ email: 'invited@example.com' })).toBeTruthy();
  });
});

describe('access requests', () => {
  it('records a home page request, tells the admins, and approval emails sign-in details', async () => {
    const admin = await adminSession();
    const visitor = supertest.agent(app);
    const csrf = (await visitor.get('/')).text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const send = (body) =>
      visitor.post('/auth/request-access').set('X-CSRF-Token', csrf).send(body);
    const before = mails.length;

    expect((await send({ name: 'A', email: 'x@example.com' })).status).toBe(400);
    // A name cannot smuggle a link line into the email.
    const phishing = await send({
      name: 'Alex\nSign in: https://evil.example/login',
      email: 'victim@example.com',
    });
    expect(phishing.status).toBe(400);
    const ok = await send({
      name: 'Asha Rao',
      email: 'Asha@Example.com',
      message: 'Swing trader\nOpen: https://evil.example/x',
    });
    expect(ok.body).toEqual({ ok: true });
    // The emails go out in the background.
    await vi.waitFor(() => expect(mails).toHaveLength(before + 2));
    const sent = mails.slice(before);
    expect(sent.map((mail) => mail.to)).toEqual(['asha@example.com', 'admin@example.com']);
    expect(sent[0].html).toContain('Pirento');
    expect(sent[1].text).toContain('> Open: https://evil.example/x');
    expect(sent[1].html).not.toContain('href="https://evil.example');
    // A repeat, a bot and an existing member get the same answer and no email.
    expect((await send({ name: 'Asha Rao', email: 'asha@example.com' })).body).toEqual({
      ok: true,
    });
    await send({ name: 'Bot', email: 'bot@example.com', website: 'spam.example' });
    await send({ name: 'Admin', email: 'admin@example.com' });
    expect(mails).toHaveLength(before + 2);

    const list = await admin.agent.get('/api/admin/access-requests');
    expect(list.body.requests).toHaveLength(1);
    const [request] = list.body.requests;
    expect(request).toMatchObject({ email: 'asha@example.com', status: 'pending' });

    const approved = await admin.send('post', `/api/admin/access-requests/${request.id}`, {
      decision: 'approve',
    });
    expect(approved.status).toBe(200);
    expect(approved.body.request.status).toBe('approved');
    expect(await AllowedUser.exists({ _id: 'asha@example.com' })).toBeTruthy();
    expect(mails.at(-1)).toMatchObject({
      to: 'asha@example.com',
      subject: 'Your Pirento Blank access is approved',
    });
    expect(mails.at(-1).text).toContain('/auth/link/activate#token=');
    expect(mails.at(-1).html).toContain('Set my password');
    // Already decided: a second click does nothing.
    const again = await admin.send('post', `/api/admin/access-requests/${request.id}`, {
      decision: 'reject',
    });
    expect(again.status).toBe(404);
    expect(await AdminAuditLog.exists({ action: 'access-request.approve' })).toBeTruthy();
  });

  it('rejects politely and keeps members out of the list', async () => {
    const admin = await adminSession();
    const visitor = supertest.agent(app);
    const csrf = (await visitor.get('/')).text.match(/name="csrf-token" content="([^"]+)"/)[1];
    await visitor
      .post('/auth/request-access')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Ravi Kumar', email: 'ravi@example.com' });
    await vi.waitFor(() => expect(mails.some((mail) => mail.to === 'ravi@example.com')).toBe(true));
    const member = await memberSession();
    expect((await member.agent.get('/api/admin/access-requests')).status).toBe(403);
    const [request] = (await admin.agent.get('/api/admin/access-requests')).body.requests;
    const rejected = await admin.send('post', `/api/admin/access-requests/${request.id}`, {
      decision: 'reject',
    });
    expect(rejected.body.request.status).toBe('rejected');
    expect(mails.at(-1)).toMatchObject({
      to: 'ravi@example.com',
      subject: 'About your request to join Pirento Blank',
    });
    expect(await AllowedUser.exists({ _id: 'ravi@example.com' })).toBeNull();
  });
});

describe('problem reports and the overview report', () => {
  it('lets a member report a problem that an admin marks fixed, and shows it on the overview', async () => {
    const admin = await adminSession();
    const member = await memberSession();
    expect(
      (await member.send('post', '/api/account/problem-report', { category: 'bug', message: 'x' }))
        .status,
    ).toBe(400);
    const sent = await member.send('post', '/api/account/problem-report', {
      category: 'data',
      message: 'The weekly P&L does not match my contract note.',
      page: '/reports',
    });
    expect(sent.status).toBe(201);
    expect(mails.at(-1)).toMatchObject({ to: 'admin@example.com' });
    expect((await member.agent.get('/api/admin/reports')).status).toBe(403);

    const overview = (await admin.agent.get('/api/admin/overview')).body;
    expect(overview.openReports).toBe(1);
    expect(overview.series).toHaveLength(30);
    expect(overview.series.at(-1).signups).toBeGreaterThanOrEqual(2);
    expect(overview.activity.some((event) => event.kind === 'report')).toBe(true);

    const [report] = (await admin.agent.get('/api/admin/reports')).body.reports;
    expect(report).toMatchObject({ status: 'open', page: '/reports' });
    const fixed = await admin.send('post', `/api/admin/reports/${report.id}/fix`, {
      note: 'Brokerage on F&O was off; fixed.',
    });
    expect(fixed.body.report.status).toBe('fixed');
    expect(mails.at(-1)).toMatchObject({
      to: 'member@example.com',
      subject: 'Your problem report has been resolved',
    });
    expect(mails.at(-1).text).toContain('Brokerage on F&O was off');
    expect((await admin.send('post', `/api/admin/reports/${report.id}/fix`, {})).status).toBe(404);
  });
});

describe('Google sign-in', () => {
  /** Runs the Google redirect round trip for `profile`; returns the final redirect. */
  async function googleRoundTrip(agent, profile, start = '/auth/google') {
    googleProfile = { email_verified: true, sub: `sub-${profile.email}`, ...profile };
    const started = await agent.get(start);
    const state = new URL(started.headers.location).searchParams.get('state');
    return (await agent.get(`/auth/google/callback?state=${state}&code=abc`)).headers.location;
  }

  beforeEach(() => {
    Object.assign(process.env, {
      GOOGLE_AUTH_ENABLED: 'true',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    });
  });
  afterEach(() => {
    for (const key of ['GOOGLE_AUTH_ENABLED', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
      delete process.env[key];
  });

  it('creates a member while sign-up is open, and lets only administrators into the admin panel', async () => {
    // Sign-up closed: a new Google address is refused.
    expect(await googleRoundTrip(supertest.agent(app), { email: 'new@gmail.com' })).toBe(
      '/login?error=invite_only',
    );

    const admin = await adminSession();
    await admin.send('put', '/api/admin/billing', { signupOpen: true });
    forgetPlanCache();
    const visitor = supertest.agent(app);
    expect(await googleRoundTrip(visitor, { email: 'New@Gmail.com' })).toBe('/dashboard');
    expect((await visitor.get('/api/account/export')).status).toBe(200);
    await vi.waitFor(() => expect(mails.at(-1)?.subject).toBe('Welcome to Pirento Blank'));

    // The admin sign-in with Google refuses a member and lets an administrator through.
    expect(
      await googleRoundTrip(
        supertest.agent(app),
        { email: 'new@gmail.com' },
        '/auth/google?for=admin',
      ),
    ).toBe('/admin/login?error=google');
    expect(
      await googleRoundTrip(
        supertest.agent(app),
        // The same Google account the administrator signed in with before.
        {
          email: 'admin@example.com',
          sub: `sub-${(await User.findOne({ email: 'admin@example.com' }))._id}`,
        },
        '/auth/google?for=admin',
      ),
    ).toBe('/admin');
  });

  /** Answers Google's token endpoint with `answer` (a bogus code is all a settings check sends). */
  function googleTokenAnswer(answer) {
    const fallback = globalThis.fetch;
    const checks = [];
    globalThis.fetch = vi.fn(async (url, options) => {
      if (String(url) !== 'https://oauth2.googleapis.com/token') return fallback(url, options);
      checks.push(Object.fromEntries(new URLSearchParams(String(options.body))));
      return answer();
    });
    return checks;
  }

  it('never saves settings that would switch off Google sign-in', async () => {
    const admin = await adminSession();
    const refused = await admin.send('put', '/api/admin/settings', {
      changes: { GOOGLE_AUTH_ENABLED: false },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/only way administrators sign in/);
    // Clearing the panel value falls back to the .env one, and a new client ID is fine once
    // Google confirms the pair (a right ID and secret with a bogus code get invalid_grant).
    const checks = googleTokenAnswer(() =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    );
    expect(
      (await admin.send('put', '/api/admin/settings', { changes: { GOOGLE_CLIENT_ID: '' } }))
        .status,
    ).toBe(200);
    expect(checks).toHaveLength(0);
    expect(
      (await admin.send('put', '/api/admin/settings', { changes: { GOOGLE_CLIENT_ID: 'new-id' } }))
        .status,
    ).toBe(200);
    expect(checks).toEqual([
      {
        grant_type: 'authorization_code',
        code: 'settings-check',
        client_id: 'new-id',
        client_secret: 'client-secret',
        redirect_uri: 'http://blank.test/auth/google/callback',
      },
    ]);
  });

  it('refuses a Google client ID and secret that Google rejects, or cannot check', async () => {
    const admin = await adminSession();
    googleTokenAnswer(() => Response.json({ error: 'invalid_client' }, { status: 401 }));
    const wrong = await admin.send('put', '/api/admin/settings', {
      changes: { GOOGLE_CLIENT_SECRET: 'mistyped-secret' },
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toMatch(/Google rejected this client ID and secret/);
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe('client-secret');
    expect(await PlatformSetting.exists({ _id: 'GOOGLE_CLIENT_SECRET' })).toBeNull();

    googleTokenAnswer(() => {
      throw new TypeError('fetch failed');
    });
    const offline = await admin.send('put', '/api/admin/settings', {
      changes: { GOOGLE_CLIENT_SECRET: 'another-secret' },
    });
    expect(offline.status).toBe(503);
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe('client-secret');
  });

  it('lets a Google-only member add a password only right after a Google sign-in', async () => {
    const admin = await adminSession();
    await admin.send('put', '/api/admin/billing', { signupOpen: true });
    forgetPlanCache();
    const visitor = supertest.agent(app);
    expect(await googleRoundTrip(visitor, { email: 'google.only@gmail.com' })).toBe('/dashboard');
    const csrf = (await visitor.get('/terms')).text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const setPassword = () =>
      visitor
        .post('/auth/password')
        .set('X-CSRF-Token', csrf)
        .send({ password: 'a-new-password-123' });
    // Ten minutes after the Google sign-in, the old session alone is not enough.
    const later = Date.now() + 11 * 60_000;
    const realNow = Date.now;
    Date.now = () => later;
    try {
      expect((await setPassword()).status).toBe(403);
    } finally {
      Date.now = realNow;
    }
    expect((await setPassword()).status).toBe(200);
  });
});

describe('password safety', () => {
  it('emails a reset link only to members, and limits guesses of the current password', async () => {
    const member = await memberSession();
    const visitor = supertest.agent(app);
    const csrf = (await visitor.get('/login')).text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const recover = (email) =>
      visitor.post('/auth/recover').set('X-CSRF-Token', csrf).send({ email });
    const before = mails.length;
    expect((await recover('nobody@example.com')).body).toEqual({ ok: true });
    expect((await recover('member@example.com')).body).toEqual({ ok: true });
    await vi.waitFor(() => expect(mails).toHaveLength(before + 1));
    expect(mails.at(-1).to).toBe('member@example.com');
    expect(mails.at(-1).text).toContain('/auth/link/recover#token=');

    const change = () =>
      member.send('post', '/auth/password', {
        currentPassword: 'wrong-password-1',
        password: 'a-new-password-123',
      });
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await change()).status).toBe(403);
    expect((await change()).status).toBe(429);
  });
});

describe('member emails', () => {
  it('emails payments, trial reminders and announcements (respecting opt-outs)', async () => {
    const { Subscription } = await import('../../models/index.js');
    const { sendTrialReminders } = await import('../../services/notifications/emails.js');
    const admin = await adminSession();
    await admin.send('put', '/api/admin/settings', {
      changes: {
        RAZORPAY_KEY_ID: 'rzp_test_abcdefgh123',
        RAZORPAY_KEY_SECRET: 'secret-value',
        RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
    });
    await admin.send('put', '/api/admin/billing', { enabled: true, trialDays: 2 });
    forgetPlanCache();
    const member = await memberSession();
    await member.agent.get('/api/billing'); // starts the 2-day trial

    // Trial ending within 3 days: one reminder, never two.
    expect(await sendTrialReminders()).toBe(1);
    expect(await sendTrialReminders()).toBe(0);
    expect(mails.at(-1)).toMatchObject({ to: 'member@example.com' });
    expect(mails.at(-1).subject).toMatch(/trial ends/);

    // A charged renewal emails a receipt.
    await Subscription.updateOne(
      { _id: member.userId },
      { $set: { razorpaySubscriptionId: 'sub_test1' } },
    );
    await signedWebhook(
      {
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: 'sub_test1',
              status: 'active',
              current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
              paid_count: 1,
            },
          },
          payment: { entity: { id: 'pay_1', amount: 49900, status: 'captured' } },
        },
      },
      'evt_charge',
    );
    await vi.waitFor(() => expect(mails.at(-1).subject).toMatch(/Payment received/));

    // An announcement reaches members who did not opt out.
    const other = await createMember({ email: 'quiet@example.com' });
    const { AccountSettings } = await import('../../models/index.js');
    await AccountSettings.create({ _id: other.user._id, announcementEmails: false });
    const before = mails.length;
    const sent = await admin.send('post', '/api/admin/announcements', {
      subject: 'New feature',
      body: 'Hello all',
      audience: 'all',
    });
    expect(sent.status).toBe(202);
    await vi.waitFor(async () => {
      const list = (await admin.agent.get('/api/admin/announcements')).body.announcements;
      expect(list[0]).toMatchObject({ status: 'done', sent: 2, skipped: 1 });
    });
    const recipients = mails.slice(before).map((mail) => mail.to);
    expect(recipients.sort()).toEqual(['admin@example.com', 'member@example.com']);
  });

  it('finishes an interrupted announcement without emailing anyone twice', async () => {
    const { Announcement } = await import('../../models/index.js');
    const { resumeAnnouncements } = await import('../../services/admin/announcements.js');
    const first = await createMember({ email: 'first@example.com' });
    await createMember({ email: 'second@example.com' });
    const [lowest] = [
      first.user._id,
      (await User.findOne({ email: 'second@example.com' }))._id,
    ].sort();
    await Announcement.create({
      subject: 'Half sent',
      body: 'Hi',
      audience: 'all',
      createdBy: 'admin',
      lastUserId: lowest,
      leaseUntil: new Date(Date.now() - 1000),
    });
    // A second "sending" announcement is refused while one is in progress.
    await expect(
      Announcement.create({ subject: 'x', body: 'y', audience: 'all', createdBy: 'admin' }),
    ).rejects.toMatchObject({ code: 11000 });
    const before = mails.length;
    await resumeAnnouncements();
    const row = await Announcement.findOne({ subject: 'Half sent' }).lean();
    expect(row).toMatchObject({ status: 'done', sent: 1 });
    expect(mails.length - before).toBe(1);
    expect(mails.at(-1).to).not.toBe((await User.findById(lowest)).email);
  });
});
