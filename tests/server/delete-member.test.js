// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  createMember,
  resetDatabase,
  signIn,
  signInAdmin,
  startTestApp,
  stopTestApp,
} from '../helpers/app.js';
import {
  AllowedUser,
  BrokerConnection,
  Payment,
  PushSubscription,
  Trade,
  User,
} from '../../models/index.js';
import { deleteMember, detachRevokedMember } from '../../services/admin/delete-member.js';
import { tradeScreenshotPath, uploadObject } from '../../services/storage.js';

// Records which members' Razorpay renewals were cancelled (no live subscription exists here).
const cancelled = vi.hoisted(() => []);
vi.mock('../../services/billing/subscriptions.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    endSubscriptionNow: async (userId) => {
      cancelled.push(String(userId));
      return actual.endSubscriptionNow(userId);
    },
  };
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let app;
beforeAll(async () => {
  // Google sign-in (administrators) builds its callback from the public origin.
  process.env.APP_URL = 'http://localhost:3000';
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetDatabase);

describe('member data removal', () => {
  it('deletes a member and their data but keeps payments', async () => {
    const { user, password } = await createMember({ email: 'leaver@example.com' });
    const other = await createMember({ email: 'stays@example.com' });
    const { agent, csrf } = await signIn(app, { email: user.email, password });
    const trade = { date: '2026-10-05', symbol: 'INFY', type: 'Long' };
    const created = await agent
      .post('/api/trades')
      .set('X-CSRF-Token', csrf)
      .send({ ...trade, entryPrice: 1500, exitPrice: 1520, quantity: 10 });
    expect(created.status).toBe(201);
    await uploadObject(
      'trade-screenshots',
      tradeScreenshotPath(user._id, created.body.trade.id),
      user._id,
      {
        mimetype: 'image/png',
        buffer: PNG,
      },
    );
    await Payment.create({
      _id: 'pay_1',
      userId: user._id,
      amount: 499,
      status: 'captured',
      paidAt: new Date(),
    });
    await Trade.create({
      ...(await Trade.findOne({ userId: user._id }).lean()),
      _id: 't2',
      userId: other.user._id,
    });

    const result = await deleteMember('Leaver@Example.com');
    expect(result).toMatchObject({ email: 'leaver@example.com', files: 1 });
    expect(await User.exists({ _id: user._id })).toBeNull();
    expect(await AllowedUser.exists({ _id: user.email })).toBeNull();
    expect(await Trade.countDocuments({ userId: user._id })).toBe(0);
    expect(await Trade.countDocuments({ userId: other.user._id })).toBe(1);
    expect(await mongoose.connection.db.collection('tradeScreenshots.files').countDocuments()).toBe(
      0,
    );
    expect(await Payment.exists({ _id: 'pay_1' })).toBeTruthy();
    // The old session no longer works.
    expect((await agent.get('/api/account/export')).status).toBe(401);
  });

  it('refuses administrators and drops a revoked member’s broker and push links', async () => {
    const admin = await createMember({ email: 'boss@example.com', role: 'admin' });
    await expect(deleteMember('boss@example.com')).rejects.toMatchObject({ status: 409 });
    const { user } = await createMember();
    await BrokerConnection.create({ userId: user._id, provider: 'kite', expiresAt: new Date() });
    await PushSubscription.create({
      userId: user._id,
      endpoint: 'https://push.test/1',
      keys: { p256dh: 'a', auth: 'b' },
    });
    await detachRevokedMember(user._id);
    expect(await BrokerConnection.countDocuments({ userId: user._id })).toBe(0);
    expect(await PushSubscription.countDocuments({ userId: user._id })).toBe(0);
    expect(await User.exists({ _id: admin.user._id })).toBeTruthy();
  });
});

describe('deleting your own account', () => {
  const sessionCount = (userId) =>
    mongoose.connection.db.collection('sessions').countDocuments({ 'session.auth.userId': userId });

  it('deletes the signed-in member after their email and password, and ends every session', async () => {
    const { user, password } = await createMember({ email: 'leaver@example.com' });
    const laptop = await signIn(app, { email: user.email, password });
    const phone = await signIn(app, { email: user.email, password });
    const send = (body) =>
      laptop.agent.post('/api/account/delete').set('X-CSRF-Token', laptop.csrf).send(body);
    await send({}).expect(400);
    await send({ confirm: 'someone@example.com', currentPassword: password }).expect(400);
    await send({ confirm: user.email, currentPassword: 'wrong password' }).expect(403);
    await laptop.agent
      .post('/api/trades')
      .set('X-CSRF-Token', laptop.csrf)
      .send({
        date: '2026-10-05',
        symbol: 'INFY',
        type: 'Long',
        entryPrice: 1,
        exitPrice: 2,
        quantity: 1,
      })
      .expect(201);
    expect(cancelled).not.toContain(String(user._id));

    const done = await send({ confirm: ' Leaver@Example.com ', currentPassword: password });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ ok: true, redirect: '/' });
    expect(cancelled).toContain(String(user._id));
    expect(await User.exists({ _id: user._id })).toBeNull();
    expect(await AllowedUser.exists({ _id: user.email })).toBeNull();
    expect(await Trade.countDocuments({ userId: user._id })).toBe(0);
    expect(await sessionCount(user._id)).toBe(0);
    expect((await laptop.agent.get('/api/account/sessions')).status).toBe(401);
    expect((await phone.agent.get('/api/account/sessions')).status).toBe(401);
  });

  it('refuses an administrator', async () => {
    const { user } = await createMember({ email: 'boss@example.com', role: 'admin' });
    const admin = await signInAdmin(app, user);
    const refused = await admin.agent
      .post('/api/account/delete')
      .set('X-CSRF-Token', admin.csrf)
      .send({ confirm: user.email, currentPassword: 'correct horse battery' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/administrator account/);
    expect(await User.exists({ _id: user._id })).toBeTruthy();
  });
});
