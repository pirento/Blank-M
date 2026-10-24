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
import mongoose from 'mongoose';
import { currentStep, totpCode } from '../../services/auth/totp.js';

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetDatabase);

describe('password sign-in and sessions', () => {
  it('signs in an invited member and loads the workspace', async () => {
    const member = await createMember();
    const { agent } = await signIn(app, { email: member.user.email, password: member.password });
    const workspace = await agent.get('/api/account/export');
    expect(workspace.status).toBe(200);
    expect(workspace.body).toMatchObject({ trades: [], strategies: [], rules: [], watchlist: [] });
    const page = await agent.get('/dashboard');
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="page-data"');
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    await createMember();
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const csrf = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
    const wrong = await agent
      .post('/auth/login')
      .set('X-CSRF-Token', csrf)
      .send({ identifier: 'member@example.com', password: 'nope-nope-nope' });
    const unknown = await agent
      .post('/auth/login')
      .set('X-CSRF-Token', csrf)
      .send({ identifier: 'ghost@example.com', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(unknown.status);
    expect(wrong.body.error).toBe(unknown.body.error);
  });

  it('requires a CSRF token for state-changing requests', async () => {
    const member = await createMember();
    const { agent } = await signIn(app, { email: member.user.email, password: member.password });
    const response = await agent.post('/api/watchlist').send({ symbol: 'INFY' });
    expect(response.status).toBe(403);
  });

  it('keeps anonymous visitors out of pages and APIs', async () => {
    expect((await request(app).get('/api/account/export')).status).toBe(401);
    const page = await request(app).get('/dashboard');
    expect(page.status).toBe(302);
    expect(page.headers.location).toMatch(/^\/login/);
  });

  it('stores visitor sessions for 2 hours (none for HEAD) and members for a week', async () => {
    const sessions = mongoose.connection.db.collection('sessions');
    expect((await request(app).head('/login')).headers['set-cookie']).toBeUndefined();
    expect(await sessions.countDocuments()).toBe(0);
    await request(app).get('/login');
    const member = await createMember();
    await signIn(app, { email: member.user.email, password: member.password });
    const hoursLeft = async (filter) =>
      ((await sessions.findOne(filter)).expires - Date.now()) / 3_600_000;
    expect(await hoursLeft({ 'session.auth': { $exists: false } })).toBeLessThanOrEqual(2);
    expect(await hoursLeft({ 'session.auth': { $exists: true } })).toBeGreaterThan(24 * 6);
  });

  it('ends the session on logout', async () => {
    const member = await createMember();
    const { agent, csrf } = await signIn(app, {
      email: member.user.email,
      password: member.password,
    });
    const logout = await agent
      .post('/auth/logout')
      .set('X-CSRF-Token', csrf)
      .set('Accept', 'application/json')
      .send({});
    expect(logout.status).toBe(200);
    expect((await agent.get('/api/account/export')).status).toBe(401);
  });

  it('rejects a request queued under a previous login session', async () => {
    const member = await createMember();
    const { agent, csrf } = await signIn(app, {
      email: member.user.email,
      password: member.password,
    });
    const response = await agent
      .post('/api/watchlist')
      .set('X-CSRF-Token', csrf)
      .set('X-Blank-Session', '00000000-0000-4000-8000-000000000000')
      .send({ symbol: 'INFY' });
    expect(response.status).toBe(409);
  });
});

describe('authenticator (TOTP) protection', () => {
  it('enrols, then requires a fresh code on the next sign-in', async () => {
    const member = await createMember();
    const first = await signIn(app, { email: member.user.email, password: member.password });
    const enrol = await first.agent
      .post('/auth/mfa/enroll')
      .set('X-CSRF-Token', first.csrf)
      .send({});
    expect(enrol.status).toBe(201);
    // The replay below reuses this exact code, even if a new step starts meanwhile.
    const usedCode = totpCode(enrol.body.secret, currentStep());
    const verify = await first.agent
      .post('/auth/mfa/verify')
      .set('X-CSRF-Token', first.csrf)
      .send({ factorId: enrol.body.id, code: usedCode });
    expect(verify.status).toBe(200);

    const second = await signIn(app, { email: member.user.email, password: member.password });
    // Password alone (aal1) cannot read workspace data once a factor is verified.
    expect((await second.agent.get('/api/account/export')).status).toBe(403);
    const reused = await second.agent
      .post('/auth/mfa/verify')
      .set('X-CSRF-Token', second.csrf)
      .send({ factorId: enrol.body.id, code: usedCode });
    // A code cannot be replayed within its step.
    expect(reused.status).toBe(400);
    const next = await second.agent
      .post('/auth/mfa/verify')
      .set('X-CSRF-Token', second.csrf)
      .send({ factorId: enrol.body.id, code: totpCode(enrol.body.secret, currentStep() + 1) });
    expect(next.status).toBe(200);
    expect((await second.agent.get('/api/account/export')).status).toBe(200);
  });
});

describe('account takeover guards', () => {
  it('does not let a password-only session finish an authenticator someone left unfinished', async () => {
    const member = await createMember();
    const post = (session, path, body) =>
      session.agent.post(path).set('X-CSRF-Token', session.csrf).send(body);
    // An "attacker" session starts a setup and leaves it unfinished.
    const attacker = await signIn(app, { email: member.user.email, password: member.password });
    const leftover = (await post(attacker, '/auth/mfa/enroll', {})).body;
    // The owner adds and verifies their own authenticator.
    const owner = await signIn(app, { email: member.user.email, password: member.password });
    const own = (await post(owner, '/auth/mfa/enroll', {})).body;
    await post(owner, '/auth/mfa/verify', {
      factorId: own.id,
      code: totpCode(own.secret, currentStep()),
    });

    const again = await signIn(app, { email: member.user.email, password: member.password });
    const refused = await post(again, '/auth/mfa/verify', {
      factorId: leftover.id,
      code: totpCode(leftover.secret, currentStep()),
    });
    expect(refused.status).toBe(403);
    expect((await again.agent.get('/api/account/export')).status).toBe(403);
  });

  it('asks for the current password to change it outside a recovery link', async () => {
    const member = await createMember();
    const session = await signIn(app, { email: member.user.email, password: member.password });
    const change = (body) =>
      session.agent.post('/auth/password').set('X-CSRF-Token', session.csrf).send(body);
    expect((await change({ password: 'new-password-123' })).status).toBe(403);
    expect(
      (await change({ password: 'new-password-123', currentPassword: 'wrong-password' })).status,
    ).toBe(403);
    expect(
      (await change({ password: 'new-password-123', currentPassword: member.password })).status,
    ).toBe(200);
    // The signed-in change form shows the extra field.
    expect((await session.agent.get('/login?mode=reset')).text).toContain('id="current-password"');
  });
});
