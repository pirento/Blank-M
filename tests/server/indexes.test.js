// @vitest-environment node
// The indexes hot queries rely on, and the TTL indexes that keep log-like collections from growing
// forever, exist once the models are synced (production builds them with autoIndex on startup).
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMember, signIn, startTestApp, stopTestApp } from '../helpers/app.js';
import { ChatMessage } from '../../models/index.js';
import { CHAT_KEEP, addChatMessage } from '../../services/journal/workspace.js';

const DAY = 24 * 60 * 60;

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);

async function indexes(collection) {
  return mongoose.connection.db.collection(collection).indexes();
}

/** The index on exactly these keys (in this order), or undefined. */
async function indexOn(collection, key) {
  const wanted = JSON.stringify(key);
  return (await indexes(collection)).find((index) => JSON.stringify(index.key) === wanted);
}

describe('database indexes', () => {
  it('supports every member-scoped hot query with userId first', async () => {
    const expected = {
      trades: [
        { userId: 1, tradeDate: -1, _id: -1 },
        { userId: 1, strategyId: 1 },
      ],
      strategies: [{ userId: 1, tradeDate: -1, _id: -1 }],
      tradingrules: [{ userId: 1, createdAt: 1, _id: 1 }],
      watchlistitems: [
        { userId: 1, symbol: 1 },
        { userId: 1, addedAt: 1, _id: 1 },
      ],
      chatmessages: [{ userId: 1, createdAt: -1, _id: -1 }],
      liveorders: [
        { userId: 1, planId: 1 },
        { userId: 1, tradingDate: 1 },
        { userId: 1, createdAt: -1 },
      ],
      papertrades: [
        { userId: 1, status: 1, openedAt: -1 },
        { userId: 1, status: 1, closedAt: -1 },
      ],
      pricealerts: [{ userId: 1, status: 1, createdAt: -1 }],
      orderplanrecords: [
        { userId: 1, recordKey: 1 },
        { userId: 1, serverRevision: 1 },
      ],
      researchruns: [
        { userId: 1, requestId: 1 },
        { userId: 1, sequence: -1 },
      ],
      aiusageevents: [{ userId: 1, createdAt: -1 }],
      coachreviews: [{ userId: 1, createdAt: -1 }],
      sharelinks: [{ userId: 1, createdAt: -1 }],
      brokerconnections: [{ userId: 1, provider: 1 }],
      journalembeddings: [{ userId: 1, sourceType: 1, sourceId: 1 }],
      strategyevidences: [{ userId: 1, serverRevision: -1 }],
    };
    const missing = [];
    for (const [collection, keys] of Object.entries(expected)) {
      for (const key of keys) {
        if (!(await indexOn(collection, key))) missing.push(`${collection} ${JSON.stringify(key)}`);
      }
    }
    expect(missing).toEqual([]);
    // userId alone on strategies is redundant with the compound index above.
    expect(await indexOn('strategies', { userId: 1 })).toBeUndefined();
  });

  it('keeps unique identities unique', async () => {
    for (const [collection, key] of [
      ['users', { email: 1 }],
      ['brokerconnections', { userId: 1, provider: 1 }],
      ['telegramlinks', { userId: 1 }],
      ['telegramlinks', { chatId: 1 }],
      ['sharelinks', { tokenHash: 1 }],
      ['authtokens', { tokenHash: 1 }],
      ['pushsubscriptions', { endpoint: 1 }],
    ]) {
      expect((await indexOn(collection, key))?.unique, `${collection}`).toBe(true);
    }
  });

  it('expires log-like collections and never member journal data', async () => {
    const ttl = {
      ratewindows: [{ expiresAt: 1 }, 0],
      authtokens: [{ expiresAt: 1 }, 7 * DAY],
      telegramlinkcodes: [{ expiresAt: 1 }, 0],
      brokeroauthstates: [{ expiresAt: 1 }, DAY],
      aiusageevents: [{ createdAt: 1 }, 90 * DAY],
      pricealerts: [{ triggeredAt: 1 }, 90 * DAY],
      researchruns: [{ startedAt: 1 }, 180 * DAY],
      sharelinks: [{ expiresAt: 1 }, 30 * DAY],
    };
    for (const [collection, [key, seconds]] of Object.entries(ttl)) {
      expect((await indexOn(collection, key))?.expireAfterSeconds, collection).toBe(seconds);
    }
    for (const collection of [
      'trades',
      'strategies',
      'tradingrules',
      'accountsettings',
      'brokerconnections',
      'liveorders',
      'orderplanrecords',
      'users',
    ]) {
      const expiring = (await indexes(collection)).filter(
        (index) => index.expireAfterSeconds !== undefined,
      );
      expect(expiring, collection).toEqual([]);
    }
  });

  it('indexes the scheduled jobs and server sessions', async () => {
    for (const field of ['weeklyReportSentFor', 'dailyAutoImportFor', 'premarketPlanFor']) {
      expect(await indexOn('accountsettings', { [field]: 1 }), field).toBeDefined();
    }
    expect(
      (await indexOn('liveorders', { status: 1, gttStatus: 1, createdAt: 1 }))
        ?.partialFilterExpression,
    ).toEqual({ autoGtt: true });
    // Upload cleanup and the screenshot sweep pick GridFS files by upload time.
    for (const bucket of ['statements', 'voiceNotes', 'tradeScreenshots']) {
      expect(await indexOn(`${bucket}.files`, { uploadDate: 1 }), bucket).toBeDefined();
    }

    // connect-mongo adds the session TTL once the store is used.
    const { password } = await createMember();
    await signIn(app, { email: 'member@example.com', password });
    expect(
      await indexOn('sessions', { 'session.auth.userId': 1, 'session.auth.sessionId': 1 }),
    ).toBeDefined();
    let ttl;
    for (let attempt = 0; attempt < 20 && !ttl; attempt += 1) {
      ttl = await indexOn('sessions', { expires: 1 });
      if (!ttl) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ttl?.expireAfterSeconds).toBe(0);
  });
});

describe('bounded documents', () => {
  it('keeps only the most recent chat messages per member', async () => {
    const start = Date.now() - 10 * DAY * 1000;
    await ChatMessage.insertMany(
      Array.from({ length: CHAT_KEEP + 5 }, (_, index) => ({
        userId: 'chatty',
        role: 'user',
        text: `old ${index}`,
        createdAt: new Date(start + index * 1000),
      })),
    );
    await ChatMessage.create({ userId: 'other', role: 'user', text: 'untouched' });
    await addChatMessage('chatty', { role: 'assistant', text: 'newest' });
    expect(await ChatMessage.countDocuments({ userId: 'chatty' })).toBe(CHAT_KEEP);
    expect(await ChatMessage.exists({ userId: 'chatty', text: 'old 0' })).toBeNull();
    expect(await ChatMessage.exists({ userId: 'chatty', text: 'newest' })).not.toBeNull();
    expect(await ChatMessage.countDocuments({ userId: 'other' })).toBe(1);
  });
});
