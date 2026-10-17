// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMember, resetDatabase, signIn, startTestApp, stopTestApp } from '../helpers/app.js';

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetDatabase);

async function member(email = 'member@example.com', existing = null) {
  const created = existing ?? (await createMember({ email }));
  const session = await signIn(app, { email, password: created.password });
  return {
    ...session,
    created,
    send: (method, path, body) =>
      session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body),
  };
}

describe('signed-in devices', () => {
  it('lists sessions and signs out another device', async () => {
    const laptop = await member();
    const phone = await member('member@example.com', laptop.created);
    const listed = (await laptop.agent.get('/api/account/sessions')).body.sessions;
    expect(listed).toHaveLength(2);
    expect(listed.filter((session) => session.current)).toHaveLength(1);
    const other = listed.find((session) => !session.current);
    expect(other).not.toHaveProperty('_id');

    const self = listed.find((session) => session.current);
    expect(
      (await laptop.send('post', '/api/account/sessions/revoke', { sessionId: self.id })).status,
    ).toBe(400);
    expect(
      (await laptop.send('post', '/api/account/sessions/revoke', { sessionId: other.id })).status,
    ).toBe(200);
    expect((await phone.agent.get('/api/workspace')).status).toBe(401);
    expect((await laptop.agent.get('/api/workspace')).status).toBe(200);
  });

  it('signs out every other device at once', async () => {
    const one = await member();
    const two = await member('member@example.com', one.created);
    const three = await member('member@example.com', one.created);
    expect((await one.send('post', '/api/account/sessions/revoke-others', {})).status).toBe(200);
    expect((await two.agent.get('/api/workspace')).status).toBe(401);
    expect((await three.agent.get('/api/workspace')).status).toBe(401);
    expect((await one.agent.get('/api/account/sessions')).body.sessions).toHaveLength(1);
  });

  it('cannot see or end another member’s sessions', async () => {
    const owner = await member('owner@example.com');
    const other = await member('other@example.com');
    const ownerSessions = (await owner.agent.get('/api/account/sessions')).body.sessions;
    const response = await other.send('post', '/api/account/sessions/revoke', {
      sessionId: ownerSessions[0].id,
    });
    expect(response.status).toBe(404);
    expect((await owner.agent.get('/api/workspace')).status).toBe(200);
  });
});

describe('data backup', () => {
  async function seed(account) {
    const { strategy } = (
      await account.send('post', '/api/strategies', {
        date: '2026-10-05',
        name: 'Gap fill',
        rules: 'Buy the half-gap fill by 10am.',
      })
    ).body;
    await account.send('post', '/api/trades', {
      date: '2026-10-05',
      symbol: 'INFY',
      type: 'Long',
      entryPrice: 1500,
      exitPrice: 1520,
      quantity: 10,
      notes: 'breakout',
      strategyId: strategy.id,
    });
    await account.send('post', '/api/rules', {
      section: 'Risk',
      definition: 'Capital',
      rule: 'Max 1% per trade',
    });
    await account.send('post', '/api/watchlist', { symbol: 'TCS' });
    await account.send('post', '/api/chat/messages', { role: 'user', text: 'hello' });
    await account.send('put', '/api/settings', { openingBalance: 250000 });
  }

  const restore = (account, backup, includeSettings = false) =>
    account.agent
      .post('/api/account/restore')
      .set('X-CSRF-Token', account.csrf)
      .field('includeSettings', String(includeSettings))
      .attach('file', Buffer.from(JSON.stringify(backup)), {
        filename: 'backup.json',
        contentType: 'application/json',
      });

  it('exports everything and restores it into another account', async () => {
    const source = await member('source@example.com');
    await seed(source);
    const exported = await source.agent.get('/api/account/export');
    expect(exported.status).toBe(200);
    expect(exported.headers['content-disposition']).toMatch(
      /attachment; filename="pirento-blank-backup-/,
    );
    const backup = JSON.parse(exported.text);
    expect(backup).toMatchObject({ format: 'pirento-blank-backup', version: 1 });
    expect(backup.trades).toHaveLength(1);

    const target = await member('target@example.com');
    const restored = await restore(target, backup, true);
    expect(restored.status).toBe(200);
    expect(restored.body.summary).toMatchObject({
      strategies: { added: 1 },
      trades: { added: 1 },
      rules: { added: 1 },
      watchlist: { added: 1 },
      chatMessages: { added: 1 },
      settings: { added: 1 },
    });
    const workspace = (await target.agent.get('/api/workspace')).body;
    expect(workspace.trades[0]).toMatchObject({
      symbol: 'INFY',
      charges: backup.trades[0].charges,
      pnl: backup.trades[0].pnl,
    });
    // The trade is linked to the restored strategy in the new account, not the source's.
    expect(workspace.trades[0].strategyId).toBe(workspace.strategies[0].id);
    expect(workspace.trades[0].id).not.toBe(backup.trades[0].id);
    expect(workspace.settings.openingBalance).toBe(250000);
    // The source account is untouched.
    expect((await source.agent.get('/api/workspace')).body.trades).toHaveLength(1);

    const again = await restore(target, backup);
    expect(again.body.summary.trades).toMatchObject({ added: 0, skipped: 1 });
    expect((await target.agent.get('/api/workspace')).body.trades).toHaveLength(1);
  });

  it('skips records already in the same account and rejects inconsistent trades', async () => {
    const account = await member();
    await seed(account);
    const backup = JSON.parse((await account.agent.get('/api/account/export')).text);
    const same = await restore(account, backup);
    expect(same.body.summary.trades).toMatchObject({ added: 0, skipped: 1 });
    backup.trades[0] = {
      ...backup.trades[0],
      id: '9b2f6b0e-5c1a-4d7e-8f3a-2b1c0d9e8f7a',
      grossPnl: 999999,
    };
    const tampered = await restore(account, backup);
    expect(tampered.body.summary.trades).toMatchObject({ invalid: 1 });
  });

  it('rejects files that are not backups', async () => {
    const account = await member();
    const response = await account.agent
      .post('/api/account/restore')
      .set('X-CSRF-Token', account.csrf)
      .attach('file', Buffer.from('{"hello":1}'), {
        filename: 'x.json',
        contentType: 'application/json',
      });
    expect(response.status).toBe(400);
  });
});

describe('restoring execution details', () => {
  it('drops only the fields that do not validate', async () => {
    const { restoredExecution } = await import('../../services/journal/backup.js');
    const trade = { type: 'Long', entryPrice: 100, quantity: 100 };
    // Legs that no longer add up to the quantity (say after a hand edit).
    const values = restoredExecution({
      ...trade,
      stopLoss: 95,
      entryTime: '09:20',
      exitTime: '15:00',
      entryOrders: 2,
      exitLegs: [
        { price: 105, quantity: 60 },
        { price: 106, quantity: 30 },
      ],
    });
    expect(values).toMatchObject({
      stopLoss: 95,
      entryTime: '09:20',
      exitTime: '15:00',
      entryOrders: 2,
      exitLegs: [],
    });
    // An exit time before the entry is dropped; the entry time stays.
    expect(
      restoredExecution({ ...trade, entryTime: '10:00', exitTime: '09:00', stopLoss: 120 }),
    ).toMatchObject({ entryTime: '10:00', exitTime: null, stopLoss: null });
  });
});
