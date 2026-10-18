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
  // Private invitation links are built from the configured public origin.
  process.env.APP_URL = 'http://localhost:3000';
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetDatabase);

async function admin() {
  const created = await createMember({ email: 'admin@example.com', role: 'admin' });
  const session = await signIn(app, { email: 'admin@example.com', password: created.password });
  return {
    ...session,
    send: (method, path, body) =>
      session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body),
  };
}

describe('administration', () => {
  it('keeps members out of administrator pages and APIs', async () => {
    const created = await createMember();
    const { agent } = await signIn(app, {
      email: 'member@example.com',
      password: created.password,
    });
    expect((await agent.get('/api/admin/users')).status).toBe(403);
    // The old address points at the admin panel, which members cannot see at all.
    const old = await agent.get('/users');
    expect(old.status).toBe(301);
    expect(old.headers.location).toBe('/admin/members');
    expect((await agent.get('/admin/members')).status).toBe(404);
    expect((await agent.get('/api/admin/overview')).status).toBe(403);
  });

  it('creates a one-use private invitation that activates a membership', async () => {
    const { send, agent } = await admin();
    const created = await send('post', '/api/admin/manual-invitations', {
      email: 'newbie@example.com',
      role: 'member',
    });
    expect(created.status).toBe(201);
    const token = new URL(created.body.url).hash.replace('#token=', '');
    const accept = await request(app)
      .post('/api/invitations/accept')
      .send({ token, password: 'a-very-strong-pass-123' });
    expect(accept.body).toEqual({ accepted: true, email: 'newbie@example.com' });
    const replay = await request(app)
      .post('/api/invitations/accept')
      .send({ token, password: 'a-very-strong-pass-123' });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    await signIn(app, { email: 'newbie@example.com', password: 'a-very-strong-pass-123' });
    const users = (await agent.get('/api/admin/users')).body.users;
    expect(users.find((user) => user.email === 'newbie@example.com')).toMatchObject({
      status: 'active',
    });
  });

  it('revokes access and ends the member’s sessions', async () => {
    const { send } = await admin();
    const created = await createMember({ email: 'leaver@example.com' });
    const leaver = await signIn(app, { email: 'leaver@example.com', password: created.password });
    const revoke = await send('post', '/api/admin/users/revoke', {
      email: 'leaver@example.com',
      userId: created.user._id,
    });
    expect(revoke.body).toMatchObject({ ok: true, workspaceAccessRevoked: true });
    expect((await leaver.agent.get('/api/workspace')).status).toBe(401);
    const again = await request(app).get('/login');
    const csrf = /name="csrf-token" content="([^"]*)"/.exec(again.text)[1];
    expect(again.status).toBe(200);
    expect(csrf).toBeTruthy();
  });

  it('cannot revoke its own access', async () => {
    const { send, agent } = await admin();
    const me = (await agent.get('/api/admin/users')).body.users.find(
      (user) => user.email === 'admin@example.com',
    );
    const response = await send('post', '/api/admin/users/revoke', {
      email: me.email,
      userId: me.userId,
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/own administrator account/);
  });
});
