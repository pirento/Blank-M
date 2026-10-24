// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMember, signIn, startTestApp, stopTestApp } from '../helpers/app.js';

// The first restore waits until the test lets it finish.
const gate = vi.hoisted(() => {
  const gate = {};
  gate.entered = new Promise((resolve) => (gate.enter = resolve));
  gate.released = new Promise((resolve) => (gate.release = resolve));
  return gate;
});
vi.mock('../../services/journal/backup.js', async (original) => ({
  ...(await original()),
  restoreBackup: async () => {
    gate.enter();
    await gate.released;
    return {};
  },
}));

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);

describe('backup restore', () => {
  it('runs one restore at a time per server process', async () => {
    const { password } = await createMember();
    const session = await signIn(app, { email: 'member@example.com', password });
    const restore = () =>
      session.agent
        .post('/api/account/restore')
        .set('X-CSRF-Token', session.csrf)
        .attach('file', Buffer.from('{}'), {
          filename: 'backup.json',
          contentType: 'application/json',
        });
    const first = restore().then((response) => response);
    await gate.entered;
    const busy = await restore();
    expect(busy.status).toBe(503);
    expect(busy.headers['retry-after']).toBe('60');
    gate.release();
    expect((await first).status).toBe(200);
    // Released again once the first restore finished.
    expect((await restore()).status).toBe(200);
  });
});
