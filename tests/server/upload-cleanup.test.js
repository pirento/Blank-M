// @vitest-environment node
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { request, resetDatabase, startTestApp, stopTestApp } from '../helpers/app.js';
import {
  statementPath,
  tradeScreenshotPath,
  uploadObject,
  voiceNotePath,
} from '../../services/storage.js';
import { Trade } from '../../models/index.js';

const SECRET = 'c'.repeat(40);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)]);
let app;

beforeAll(async () => {
  process.env.CRON_SECRET = SECRET;
  app = await startTestApp();
});
afterAll(async () => {
  delete process.env.CRON_SECRET;
  await stopTestApp();
});
beforeEach(resetDatabase);

/** Moves a stored file's upload time back by `days`. */
async function age(bucketName, path, days) {
  await mongoose.connection.db
    .collection(`${bucketName}.files`)
    .updateOne(
      { filename: path },
      { $set: { uploadDate: new Date(Date.now() - days * 86_400_000) } },
    );
}

describe('upload cleanup', () => {
  it('deletes voice notes after a day and statements after a week', async () => {
    const user = randomUUID();
    const oldStatement = await uploadObject('statements', statementPath(user, 'a.png'), user, {
      mimetype: 'image/png',
      buffer: PNG,
    });
    const newStatement = await uploadObject('statements', statementPath(user, 'b.png'), user, {
      mimetype: 'image/png',
      buffer: PNG,
    });
    const oldVoice = await uploadObject('voice-notes', voiceNotePath(user, 'v.mp3').path, user, {
      mimetype: 'audio/mpeg',
      buffer: MP3,
    });
    await age('statements', oldStatement, 8);
    await age('statements', newStatement, 2);
    await age('voiceNotes', oldVoice, 2);

    const response = await request(app)
      .post('/api/maintenance/voice-notes')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(response.body).toMatchObject({ deleted: 2, moreMayRemain: false });
    const left = await mongoose.connection.db.collection('statements.files').find().toArray();
    expect(left.map((file) => file.filename)).toEqual([newStatement]);
  });

  it('sweeps screenshot files older than a day that no trade points to', async () => {
    const user = randomUUID();
    const tradeId = randomUUID();
    const shot = (trade) =>
      uploadObject('trade-screenshots', tradeScreenshotPath(user, trade), user, {
        mimetype: 'image/png',
        buffer: PNG,
      });
    const current = await shot(tradeId);
    const replaced = await shot(tradeId);
    const deletedTrade = await shot(randomUUID());
    const fresh = await shot(randomUUID());
    // Only the fields the sweep reads.
    await Trade.collection.insertOne({ _id: tradeId, userId: user, screenshotPath: current });
    for (const path of [current, replaced, deletedTrade]) await age('tradeScreenshots', path, 2);

    const response = await request(app)
      .post('/api/maintenance/voice-notes')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(response.body).toMatchObject({ deleted: 2, moreMayRemain: false });
    const left = await mongoose.connection.db.collection('tradeScreenshots.files').find().toArray();
    expect(left.map((file) => file.filename).sort()).toEqual([current, fresh].sort());
  });
});
