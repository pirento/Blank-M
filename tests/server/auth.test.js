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
    const workspace = await agent.get('/api/workspace');
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
    expect((await request(app).get('/api/workspace')).status).toBe(401);
    const page = await request(app).get('/dashboard');
    expect(page.status).toBe(302);
    expect(page.headers.location).toMatch(/^\/login/);
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
    expect((await agent.get('/api/workspace')).status).toBe(401);
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
    expect((await second.agent.get('/api/workspace')).status).toBe(403);
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
    expect((await second.agent.get('/api/workspace')).status).toBe(200);
  });
});
