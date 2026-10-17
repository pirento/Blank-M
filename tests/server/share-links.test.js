// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createMember, resetDatabase, signIn, startTestApp, stopTestApp } from '../helpers/app.js';
import { ShareLink } from '../../models/index.js';

let app;
beforeAll(async () => {
  process.env.APP_URL = 'http://localhost:3000';
  app = await startTestApp();
});
afterAll(async () => {
  delete process.env.APP_URL;
  await stopTestApp();
});
beforeEach(resetDatabase);

async function member(email = 'member@example.com') {
  const created = await createMember({ email });
  const session = await signIn(app, { email, password: created.password });
  const send = (method, path, body) =>
    session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body);
  return { ...session, send };
}

describe('mentor share links', () => {
  it('shares trades read-only without notes, capital or email, until revoked', async () => {
    const { send } = await member();
    await send('post', '/api/trades', {
      date: '2026-10-05',
      symbol: 'INFY',
      type: 'Long',
      entryPrice: 100,
      exitPrice: 110,
      quantity: 10,
      notes: 'private reflection',
      mistakeTags: ['Late exit'],
    });
    const created = await send('post', '/api/share-links', { label: 'Mentor', days: 7 });
    expect(created.status).toBe(201);
    const path = new URL(created.body.url).pathname;
    const token = path.split('/').at(-1);
    // Only a digest of the token is stored.
    expect(await ShareLink.exists({ tokenHash: token })).toBeNull();

    const page = await request(app).get(path);
    expect(page.status).toBe(200);
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(page.text).toContain('INFY');
    expect(page.text).toContain('Late exit');
    expect(page.text).not.toContain('private reflection');
    expect(page.text).not.toContain('member@example.com');
    expect(page.text).not.toContain('openingBalance');

    const list = await send('get', '/api/share-links');
    expect(list.body.links[0]).toMatchObject({ label: 'Mentor', status: 'active', viewCount: 1 });

    const other = await member('other@example.com');
    expect(
      (await other.send('post', `/api/share-links/${list.body.links[0].id}/revoke`)).status,
    ).toBe(404);
    expect((await send('post', `/api/share-links/${list.body.links[0].id}/revoke`)).status).toBe(
      200,
    );
    expect((await request(app).get(path)).status).toBe(404);
  });

  it('includes notes only when chosen and rejects bad input', async () => {
    const { send } = await member();
    await send('post', '/api/trades', {
      date: '2026-10-05',
      symbol: 'TCS',
      type: 'Long',
      entryPrice: 100,
      exitPrice: 90,
      quantity: 1,
      notes: 'shared thought',
    });
    const created = await send('post', '/api/share-links', { days: 30, includeNotes: true });
    const page = await request(app).get(new URL(created.body.url).pathname);
    expect(page.text).toContain('shared thought');
    expect((await send('post', '/api/share-links', { days: 3 })).status).toBe(400);
    expect((await request(app).get('/share/not-a-token')).status).toBe(404);
  });
});
