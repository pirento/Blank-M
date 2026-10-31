// @vitest-environment node
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMember, resetDatabase, signIn, startTestApp, stopTestApp } from '../helpers/app.js';
import {
  downloadObject,
  migrateScreenshotsToS3,
  ownerBytes,
  removeObjects,
  removeOwnerFolder,
  resetS3,
  streamObject,
  tradeScreenshotPath,
  uploadObject,
} from '../../services/storage.js';
import { removeOrphanScreenshots } from '../../services/journal/workspace.js';
import { savePlatformSettings } from '../../services/platform/settings.js';
import { Trade } from '../../models/index.js';

const BUCKET = 'shots';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
/** Small list pages, so the code has to follow continuation tokens. */
const PAGE = 2;
/** The fake bucket: key → { body, type, modified }. Keys here are plain UUID paths. */
const objects = new Map();
let refusePuts = false;

/** Just enough of S3 with path-style addresses (/<bucket>/<key>) for services/storage.js. */
async function fakeS3(req, res) {
  const url = new URL(req.url, 'http://fake-s3');
  const [, bucket, ...rest] = url.pathname.split('/');
  const key = decodeURIComponent(rest.join('/'));
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const send = (status, text = '', headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/xml', ...headers });
    res.end(text);
  };
  if (bucket !== BUCKET) return send(404, '<Error><Code>NoSuchBucket</Code></Error>');
  if (req.method === 'PUT' && key) {
    if (refusePuts) return send(403, '<Error><Code>AccessDenied</Code></Error>');
    const type = req.headers['content-type'];
    objects.set(key, { body: Buffer.concat(chunks), type, modified: new Date() });
    return send(200, '', { ETag: '"etag"' });
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && key) {
    const object = objects.get(key);
    if (!object) return send(404, '<Error><Code>NoSuchKey</Code></Error>');
    res.writeHead(200, {
      'Content-Type': object.type,
      'Content-Length': object.body.length,
      'Last-Modified': object.modified.toUTCString(),
      ETag: '"etag"',
    });
    return res.end(req.method === 'HEAD' ? undefined : object.body);
  }
  if (req.method === 'POST' && url.searchParams.has('delete')) {
    const keys = [
      ...Buffer.concat(chunks)
        .toString()
        .matchAll(/<Key>(.*?)<\/Key>/g),
    ].map((match) => match[1]);
    for (const name of keys) objects.delete(name);
    const deleted = keys.map((name) => `<Deleted><Key>${name}</Key></Deleted>`).join('');
    return send(200, `<DeleteResult>${deleted}</DeleteResult>`);
  }
  if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
    const prefix = url.searchParams.get('prefix') ?? '';
    const after =
      url.searchParams.get('continuation-token') ?? url.searchParams.get('start-after') ?? '';
    const keys = [...objects.keys()].filter((name) => name.startsWith(prefix) && name > after);
    const page = keys.sort().slice(0, PAGE);
    const truncated = keys.length > PAGE;
    const contents = page
      .map((name) => {
        const { body, modified } = objects.get(name);
        return `<Contents><Key>${name}</Key><LastModified>${modified.toISOString()}</LastModified><Size>${body.length}</Size></Contents>`;
      })
      .join('');
    const next = truncated ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : '';
    return send(
      200,
      `<ListBucketResult><Name>${BUCKET}</Name><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`,
    );
  }
  return send(501, '<Error><Code>NotImplemented</Code></Error>');
}

const S3_ENV = {
  S3_BUCKET: BUCKET,
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_FORCE_PATH_STYLE: 'true',
};
const files = () => mongoose.connection.db.collection('tradeScreenshots.files');
const shot = (user, trade = randomUUID()) =>
  uploadObject('trade-screenshots', tradeScreenshotPath(user, trade), user, {
    mimetype: 'image/png',
    buffer: PNG,
  });
/** Runs `fn` with S3 switched off, as before the bucket was set up. */
async function withoutS3(fn) {
  delete process.env.S3_BUCKET;
  try {
    return await fn();
  } finally {
    process.env.S3_BUCKET = BUCKET;
  }
}

let app;
let server;
let endpoint;
beforeAll(async () => {
  server = createServer((req, res) => void fakeS3(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, S3_ENV, { S3_ENDPOINT: endpoint });
  resetS3();
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of [...Object.keys(S3_ENV), 'S3_ENDPOINT']) delete process.env[key];
  resetS3();
  await stopTestApp();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(async () => {
  objects.clear();
  refusePuts = false;
  await resetDatabase();
});

describe('trade screenshots in S3', () => {
  it('uploads, streams, counts and removes files in the bucket, not in GridFS', async () => {
    const user = randomUUID();
    const path = await shot(user);
    expect(objects.get(path)).toMatchObject({ body: PNG, type: 'image/png' });
    expect(await files().countDocuments()).toBe(0);
    const stream = await streamObject('trade-screenshots', path);
    expect(stream).toMatchObject({ length: PNG.length, contentType: 'image/png' });
    stream.stream.destroy();
    expect(await downloadObject('trade-screenshots', path)).toEqual({
      buffer: PNG,
      contentType: 'image/png',
    });

    await shot(user);
    await shot(user);
    await shot(randomUUID());
    // Three files over two list pages; the other member's file is not counted.
    expect(await ownerBytes('trade-screenshots', user)).toBe(3 * PNG.length);
    expect(await removeObjects('trade-screenshots', [path])).toEqual([{ name: path }]);
    expect(await streamObject('trade-screenshots', path)).toBeNull();
    expect(await removeOwnerFolder('trade-screenshots', user)).toBe(2);
    expect(objects.size).toBe(1);
  });

  it('serves a screenshot through the API', async () => {
    const created = await createMember();
    const session = await signIn(app, { email: 'member@example.com', password: created.password });
    const { trade } = (
      await session.agent.post('/api/trades').set('X-CSRF-Token', session.csrf).send({
        date: '2026-10-05',
        symbol: 'INFY',
        type: 'Long',
        entryPrice: 1500,
        exitPrice: 1520,
        quantity: 10,
        notes: '',
      })
    ).body;
    const upload = await session.agent
      .post(`/api/trades/${trade.id}/screenshot`)
      .set('X-CSRF-Token', session.csrf)
      .attach('file', PNG, { filename: 'chart.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(objects.size).toBe(1);
    const image = await session.agent.get(`/api/trades/${trade.id}/screenshot`);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toMatch(/^image\/png/);
    expect(Buffer.compare(image.body, PNG)).toBe(0);
  });

  it('reads files not copied yet from GridFS and removes those copies too', async () => {
    const user = randomUUID();
    const path = await withoutS3(() => shot(user));
    expect(objects.size).toBe(0);
    expect(await downloadObject('trade-screenshots', path)).toEqual({
      buffer: PNG,
      contentType: 'image/png',
    });
    expect(await ownerBytes('trade-screenshots', user)).toBe(PNG.length);
    await removeObjects('trade-screenshots', [path]);
    expect(await files().countDocuments()).toBe(0);
  });

  it('sweeps S3 files older than a day that no trade points to', async () => {
    const user = randomUUID();
    const tradeId = randomUUID();
    const current = await shot(user, tradeId);
    const replaced = await shot(user, tradeId);
    const orphan = await shot(user);
    const fresh = await shot(user);
    await Trade.collection.insertOne({ _id: tradeId, userId: user, screenshotPath: current });
    // Someone else's objects in a shared bucket, even under a member-like folder, are not ours.
    const foreign = ['backups/db.tar', `${user}/notes.txt`, `${user}/${tradeId}/x/y`];
    for (const key of foreign) objects.set(key, { body: PNG, type: 'text/plain' });
    for (const path of [current, replaced, orphan, ...foreign]) {
      objects.get(path).modified = new Date(Date.now() - 2 * 86_400_000);
    }
    expect(await removeOrphanScreenshots()).toEqual({ deleted: 2, moreMayRemain: false });
    expect([...objects.keys()].sort()).toEqual([current, fresh, ...foreign].sort());
  });

  it('copies GridFS screenshots to S3, skips copies already there, and deletes only with remove', async () => {
    const user = randomUUID();
    const [kept, partial, missing] = await withoutS3(() =>
      Promise.all([shot(user), shot(user), shot(user)]),
    );
    objects.set(kept, { body: PNG, type: 'image/png', modified: new Date() });
    // An interrupted earlier copy: wrong size, so it is copied again.
    objects.set(partial, { body: PNG.subarray(0, 3), type: 'image/png', modified: new Date() });

    expect(await migrateScreenshotsToS3()).toEqual({
      copied: 2,
      present: 1,
      removed: 0,
      failed: 0,
    });
    for (const path of [kept, partial, missing]) {
      expect(objects.get(path)).toMatchObject({ body: PNG, type: 'image/png' });
    }
    expect(await files().countDocuments()).toBe(3);

    expect(await migrateScreenshotsToS3({ remove: true })).toEqual({
      copied: 0,
      present: 3,
      removed: 3,
      failed: 0,
    });
    expect(await files().countDocuments()).toBe(0);
    expect(await downloadObject('trade-screenshots', missing)).toMatchObject({ buffer: PNG });
  });

  it('keeps the GridFS copy when the copy to S3 fails', async () => {
    const user = randomUUID();
    await withoutS3(() => shot(user));
    refusePuts = true;
    const log = [];
    expect(await migrateScreenshotsToS3({ remove: true, log: (line) => log.push(line) })).toEqual({
      copied: 0,
      present: 0,
      removed: 0,
      failed: 1,
    });
    expect(log[0]).toMatch(/^Failed /);
    expect(await files().countDocuments()).toBe(1);
  });

  it('rebuilds the S3 client when a setting changes in the admin panel', async () => {
    const actor = { id: randomUUID(), email: 'admin@example.com' };
    const user = randomUUID();
    await shot(user);
    await savePlatformSettings(actor, { S3_ENDPOINT: 'http://127.0.0.1:1' });
    await expect(shot(user)).rejects.toThrow();
    // The panel stores the URL with a trailing slash.
    await savePlatformSettings(actor, { S3_ENDPOINT: endpoint });
    expect(process.env.S3_ENDPOINT).toBe(`${endpoint}/`);
    await shot(user);
    await savePlatformSettings(actor, { S3_ENDPOINT: '' });
    expect(process.env.S3_ENDPOINT).toBe(endpoint);
    expect(objects.size).toBe(2);
  });
});
