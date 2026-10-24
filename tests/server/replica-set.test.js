// @vitest-environment node
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from '../../config/database.js';
import { createApp } from '../../app.js';
import { createMember, request, signIn } from '../helpers/app.js';

let replSet;
let app;
beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await connectDatabase(replSet.getUri('blank-replset'));
  app = createApp();
});
afterAll(async () => {
  await disconnectDatabase();
  await replSet?.stop();
});

it('runs on a replica set: a member signs in, writes and reads back a trade', async () => {
  // The driver retries writes by default, and a replica set's implicit write concern is majority.
  expect(mongoose.connection.getClient().options.retryWrites).toBe(true);
  const { defaultWriteConcern } = await mongoose.connection.db
    .admin()
    .command({ getDefaultRWConcern: 1 });
  expect(defaultWriteConcern.w).toBe('majority');
  expect((await request(app).get('/api/health')).status).toBe(200);

  const { password } = await createMember();
  const { agent, csrf } = await signIn(app, { email: 'member@example.com', password });
  const created = await agent.post('/api/trades').set('X-CSRF-Token', csrf).send({
    date: '2026-10-05',
    symbol: 'INFY',
    type: 'Long',
    entryPrice: 1500,
    exitPrice: 1520,
    quantity: 10,
    notes: 'on a replica set',
  });
  expect(created.status).toBe(201);
  const backup = await agent.get('/api/account/export');
  expect(backup.status).toBe(200);
  expect(backup.body.trades).toEqual([
    expect.objectContaining({ id: created.body.trade.id, notes: 'on a replica set' }),
  ]);
});

it('reports 503 while there is no primary and recovers after the election', async () => {
  // A one-node set elects itself again once the one-second step-down ends.
  await mongoose.connection.db
    .admin()
    .command({ replSetStepDown: 1, secondaryCatchUpPeriodSecs: 0, force: true });
  await vi.waitFor(() => expect(isDatabaseConnected()).toBe(false));
  expect((await request(app).get('/api/health')).status).toBe(503);
  await vi.waitFor(() => expect(isDatabaseConnected()).toBe(true), { timeout: 20_000 });
  expect((await request(app).get('/api/health')).status).toBe(200);
});
