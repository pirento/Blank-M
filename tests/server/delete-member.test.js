// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMember, resetDatabase, signIn, startTestApp, stopTestApp } from '../helpers/app.js';
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

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let app;
beforeAll(async () => {
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
    expect((await agent.get('/api/workspace')).status).toBe(401);
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
