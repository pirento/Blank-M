// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const market = vi.hoisted(() => ({ prices: {}, reads: [] }));
const pushes = vi.hoisted(() => ({ sent: [], fail: null }));
vi.mock('../../services/market/index.js', async (original) => ({
  ...(await original()),
  getQuote: async (symbol) => {
    market.reads.push(symbol);
    if (!(symbol in market.prices)) throw new Error('no quote');
    return { price: market.prices[symbol] };
  },
}));
vi.mock('web-push', () => ({
  default: {
    sendNotification: async (subscription, payload) => {
      if (pushes.fail) throw Object.assign(new Error('gone'), { statusCode: pushes.fail });
      pushes.sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
    },
    generateVAPIDKeys: () => ({ publicKey: 'p', privateKey: 'q' }),
  },
}));

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const { setMailTransport } = await import('../../services/mailer.js');
const supertest = (await import('supertest')).default;

const SECRET = 'y'.repeat(40);
const mails = [];
let app;
beforeAll(async () => {
  Object.assign(process.env, {
    CRON_SECRET: SECRET,
    VAPID_PUBLIC_KEY: 'BPublicKeyForTests',
    VAPID_PRIVATE_KEY: 'privateKeyForTests',
    SMTP_HOST: 'smtp.test',
    SMTP_FROM: 'Blank <blank@example.com>',
  });
  setMailTransport({ sendMail: async (message) => mails.push(message) });
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of [
    'CRON_SECRET',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'SMTP_HOST',
    'SMTP_FROM',
  ])
    delete process.env[key];
  setMailTransport(null);
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  market.prices = { INFY: 1500 };
  pushes.sent = [];
  pushes.fail = null;
  mails.length = 0;
});

async function member() {
  const { password } = await createMember();
  const session = await signIn(app, { email: 'member@example.com', password });
  const send = (method, path, body) =>
    session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body);
  return { ...session, send };
}
const SUBSCRIPTION = {
  endpoint: 'https://push.example.com/send/abc',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

describe('price alerts', () => {
  it('fires once when crossed and notifies by push and email', async () => {
    const { send } = await member();
    expect((await send('post', '/api/push/subscribe', { subscription: SUBSCRIPTION })).status).toBe(
      201,
    );
    const created = await send('post', '/api/alerts', {
      symbol: 'infy',
      condition: 'above',
      price: 1520,
      note: 'breakout',
      channels: { push: true, email: true },
    });
    expect(created.status).toBe(201);
    expect(created.body.alert).toMatchObject({ symbol: 'INFY', status: 'active' });

    let check = await send('post', '/api/alerts/check');
    expect(check.body.fired).toEqual([]);

    market.prices.INFY = 1525;
    check = await send('post', '/api/alerts/check');
    expect(check.body.fired).toEqual([
      expect.objectContaining({ symbol: 'INFY', status: 'triggered', triggeredPrice: 1525 }),
    ]);
    expect(pushes.sent).toEqual([
      expect.objectContaining({
        endpoint: SUBSCRIPTION.endpoint,
        payload: expect.objectContaining({ title: 'INFY rose to ₹1525', url: '/watchlist' }),
      }),
    ]);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('INFY rose to ₹1525');

    // Already fired: a second check (or the scheduled job) does not notify again.
    await send('post', '/api/alerts/check');
    const run = await supertest(app)
      .post('/api/maintenance/price-checks')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(run.body.alerts).toMatchObject({ checked: 0, fired: 0 });
    expect(pushes.sent).toHaveLength(1);

    const rearmed = await send('post', `/api/alerts/${created.body.alert.id}/reactivate`);
    expect(rearmed.body.alert.status).toBe('active');
  });

  it('is fired by the scheduled check and drops subscriptions the push service rejects', async () => {
    const { send } = await member();
    await send('post', '/api/push/subscribe', { subscription: SUBSCRIPTION });
    await send('post', '/api/alerts', { symbol: 'INFY', condition: 'below', price: 1490 });
    market.prices.INFY = 1480;
    pushes.fail = 410;
    const run = await supertest(app)
      .post('/api/maintenance/price-checks')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(run.body.alerts).toMatchObject({ checked: 1, fired: 1 });
    expect((await send('get', '/api/push')).body.devices).toBe(0);
  });

  it('validates alerts and subscriptions', async () => {
    const { send } = await member();
    expect(
      (await send('post', '/api/alerts', { symbol: 'INFY', condition: 'near', price: 1 })).status,
    ).toBe(400);
    expect(
      (await send('post', '/api/alerts', { symbol: 'INFY', condition: 'above', price: -1 })).status,
    ).toBe(400);
    const insecure = await send('post', '/api/push/subscribe', {
      subscription: { ...SUBSCRIPTION, endpoint: 'http://push.example.com/x' },
    });
    expect(insecure.status).toBe(400);
    expect((await send('get', '/api/push')).body).toMatchObject({ configured: true, devices: 0 });
  });

  it('limits each member’s quote reads and alert checks, with Retry-After', async () => {
    const { RateWindow } = await import('../../models/index.js');
    const { send } = await member();
    expect((await send('get', '/api/quote?symbol=INFY')).status).toBe(200);
    // Use up this minute's allowance instead of sending 240 requests.
    await RateWindow.updateOne({ _id: /^prices:/ }, { $set: { attempts: 240 } });
    const quote = await send('get', '/api/quote?symbol=INFY');
    expect(quote.status).toBe(429);
    expect(Number(quote.headers['retry-after'])).toBeGreaterThan(0);
    for (let run = 0; run < 6; run += 1) {
      expect((await send('post', '/api/alerts/check')).status).toBe(200);
    }
    const check = await send('post', '/api/alerts/check');
    expect(check.status).toBe(429);
    expect(Number(check.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('scheduled price check at scale', () => {
  it('reads one price per symbol for every member’s alerts', async () => {
    const { PriceAlert } = await import('../../models/index.js');
    const { checkAllAlerts } = await import('../../services/notifications/price-alerts.js');
    await PriceAlert.create(
      ['u1', 'u2', 'u3'].map((userId) => ({
        userId,
        symbol: 'INFY',
        condition: 'above',
        price: 1000,
        channels: { push: false, email: false, telegram: false },
      })),
    );
    market.prices.INFY = 1500;
    market.reads.length = 0;
    expect(await checkAllAlerts()).toMatchObject({ checked: 3, fired: 3 });
    expect(market.reads).toEqual(['INFY']);
  });
});
