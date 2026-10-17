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

let app;
beforeAll(async () => {
  process.env.APP_URL = 'http://localhost:3000';
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetDatabase);

async function anonymous() {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { agent, csrf };
}

async function admin() {
  const created = await createMember({ email: 'admin@example.com', role: 'admin' });
  const session = await signIn(app, { email: 'admin@example.com', password: created.password });
  return {
    ...session,
    send: (path, body) => session.agent.post(path).set('X-CSRF-Token', session.csrf).send(body),
  };
}

describe('password recovery without email delivery', () => {
  it('answers identically for members and unknown addresses', async () => {
    await createMember();
    const { agent, csrf } = await anonymous();
    const member = await agent
      .post('/auth/recover')
      .set('X-CSRF-Token', csrf)
      .send({ email: 'member@example.com' });
    const unknown = await agent
      .post('/auth/recover')
      .set('X-CSRF-Token', csrf)
      .send({ email: 'ghost@example.com' });
    expect(member.status).toBe(unknown.status);
    expect(member.body).toEqual(unknown.body);
    expect(member.body.error).toMatch(/Ask your administrator/);
  });

  it('tells visitors on the reset page to ask an administrator', async () => {
    const page = await request(app).get('/login?mode=reset');
    expect(page.text).toContain('data-reset-unavailable');
  });
});

describe('administrator reset links', () => {
  it('lets a member set a new password with a one-time link', async () => {
    const { send } = await admin();
    await createMember({ email: 'forgetful@example.com' });
    const created = await send('/api/admin/users/reset-link', { email: 'forgetful@example.com' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ email: 'forgetful@example.com', emailSent: false });
    const token = new URL(created.body.url).hash.replace('#token=', '');

    const visitor = await anonymous();
    const exchange = await visitor.agent
      .post('/auth/link')
      .set('X-CSRF-Token', visitor.csrf)
      .send({ purpose: 'recover', token });
    expect(exchange.body.redirect).toBe('/login?mode=recover');
    const changed = await visitor.agent
      .post('/auth/password')
      .set('X-CSRF-Token', exchange.body.csrfToken)
      .send({ password: 'a-brand-new-password-1' });
    expect(changed.status).toBe(200);
    await signIn(app, { email: 'forgetful@example.com', password: 'a-brand-new-password-1' });

    const replay = await anonymous();
    const reused = await replay.agent
      .post('/auth/link')
      .set('X-CSRF-Token', replay.csrf)
      .send({ purpose: 'recover', token });
    expect(reused.status).toBe(400);
  });

  it('refuses members without active access and non-administrators', async () => {
    const { send } = await admin();
    const response = await send('/api/admin/users/reset-link', { email: 'nobody@example.com' });
    expect(response.status).toBe(409);

    const created = await createMember({ email: 'plain@example.com' });
    const member = await signIn(app, { email: 'plain@example.com', password: created.password });
    const denied = await member.agent
      .post('/api/admin/users/reset-link')
      .set('X-CSRF-Token', member.csrf)
      .send({ email: 'admin@example.com' });
    expect(denied.status).toBe(403);
  });

  it('keeps the instrument refresh administrator-only', async () => {
    const created = await createMember({ email: 'plain@example.com' });
    const member = await signIn(app, { email: 'plain@example.com', password: created.password });
    const denied = await member.agent
      .post('/api/instruments/refresh')
      .set('X-CSRF-Token', member.csrf)
      .send({});
    expect(denied.status).toBe(403);
  });
});
