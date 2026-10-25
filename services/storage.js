/**
 * File storage in MongoDB GridFS: statements, temporary voice notes and trade
 * chart screenshots, each in the owner's folder. Trade screenshots (the only bucket
 * that keeps growing) go to an S3-compatible bucket instead once S3_BUCKET and its
 * keys are set; files not copied there yet are still read from GridFS.
 */
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import mongoose from 'mongoose';
import { nativeDb } from '../config/database.js';
import { HttpError } from './errors.js';
import { isSafeOwnerStoragePath } from './storage-path.js';

/** Private owner-folder file storage in MongoDB GridFS buckets. */
export const BUCKETS = {
  statements: {
    name: 'statements',
    maxBytes: 10 * 1024 * 1024,
    mime: new Set(['application/pdf', 'image/png', 'image/jpeg']),
    mimeError: 'Only PDF, PNG, and JPEG statements are supported.',
    sizeError: 'The file must be 10 MB or smaller.',
  },
  'voice-notes': {
    name: 'voiceNotes',
    maxBytes: 10 * 1024 * 1024,
    mime: new Set([
      'audio/mpeg',
      'audio/mp4',
      'audio/wav',
      'audio/webm',
      'audio/ogg',
      'audio/x-m4a',
    ]),
    mimeError: 'This voice-note format is not supported.',
    sizeError: 'The file must be 10 MB or smaller.',
  },
  'trade-screenshots': {
    name: 'tradeScreenshots',
    maxBytes: 5 * 1024 * 1024,
    mime: new Set(['image/png', 'image/jpeg', 'image/webp']),
    mimeError: 'Screenshots must be PNG, JPEG or WebP images.',
    sizeError: 'Screenshots must be 5 MB or smaller.',
    s3: true,
  },
};

/**
 * File signatures for the types whose contents can be checked cheaply. The
 * declared type comes from the browser; the first bytes must agree with it,
 * so a script renamed to .png is refused. Audio formats are not checked.
 */
const SIGNATURES = {
  // PDF readers accept the header anywhere in the first 1 KB (some bank statements lead with junk).
  'application/pdf': (bytes) => bytes.subarray(0, 1024).includes('%PDF-', 0, 'latin1'),
  'image/png': (bytes) =>
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/jpeg': (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': (bytes) =>
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP',
};

/**
 * Whether the file's first bytes match its declared type; types without a known signature always
 * pass.
 */
export function contentMatchesType(buffer, contentType) {
  const check = SIGNATURES[contentType];
  return check ? check(buffer) : true;
}

function bucket(name) {
  const config = BUCKETS[name];
  if (!config) throw new Error(`Unknown storage bucket ${name}`);
  return {
    config,
    gridfs: new mongoose.mongo.GridFSBucket(nativeDb(), { bucketName: config.name }),
  };
}

let s3Client = null;

/** Forgets the S3 client so the next call uses the current S3_* settings. */
export function resetS3() {
  s3Client?.destroy();
  s3Client = null;
}

/** `{ client, bucket }` when this bucket's files go to S3 (bucket and both keys set), else null. */
function s3For(bucketName) {
  const env = process.env;
  const name = env.S3_BUCKET?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!BUCKETS[bucketName]?.s3 || !name || !accessKeyId || !secretAccessKey) return null;
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  s3Client ??= new S3Client({
    region: env.S3_REGION?.trim() || (endpoint ? 'auto' : 'ap-south-1'),
    endpoint,
    forcePathStyle: /^(1|true)$/i.test(env.S3_FORCE_PATH_STYLE || ''),
    credentials: { accessKeyId, secretAccessKey },
    // R2, Spaces, Wasabi and MinIO do not all accept the SDK's newer default checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { client: s3Client, bucket: name };
}

/** Every object matching the ListObjectsV2 `params` (Prefix, StartAfter), page by page. */
async function* s3Objects({ client, bucket: Bucket }, params) {
  let ContinuationToken;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket, ...params, ContinuationToken }),
    );
    yield* page.Contents ?? [];
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

/** Deletes the keys (DeleteObjects takes at most 1000 at a time); returns `{ name }` per key. */
async function s3Remove({ client, bucket: Bucket }, keys) {
  const removed = [];
  for (let start = 0; start < keys.length; start += 1000) {
    const Objects = keys.slice(start, start + 1000).map((Key) => ({ Key }));
    const result = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects } }));
    if (result.Errors?.length) {
      throw new Error(`S3 refused to delete ${result.Errors.length} file(s)`);
    }
    removed.push(...(result.Deleted ?? []).map((item) => ({ name: item.Key })));
  }
  return removed;
}

/** The object's size in S3, or null when it is not there. */
async function s3Size({ client, bucket: Bucket }, Key) {
  try {
    return (await client.send(new HeadObjectCommand({ Bucket, Key }))).ContentLength;
  } catch (error) {
    if (error.name === 'NotFound') return null;
    throw error;
  }
}

/** Same naming as the original client upload: `<owner>/<time>-<safe name>`. */
export function statementPath(userId, originalName) {
  const safeName = String(originalName || 'statement')
    .replace(/[^\w.-]/g, '_')
    .slice(-80);
  return `${userId}/${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`;
}

/** `<owner>/<trade>/<random>`: a new name per upload, so a replaced image is never served stale. */
export function tradeScreenshotPath(userId, tradeId) {
  return `${userId}/${tradeId}/${randomUUID()}`;
}

/** A unique `<owner>/<uuid>-<safe name>` path for a voice note, plus the sanitised filename. */
export function voiceNotePath(userId, originalName) {
  const filename = String(originalName || 'voice-note.webm')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(-120);
  return { path: `${userId}/${randomUUID()}-${filename}`, filename };
}

/**
 * Stores an uploaded file in the bucket at `path` after checking the path is in the member's folder
 * (403), the type is allowed (415), the content matches the type (415), the file is non-empty (400)
 * and within size (413), and the path is unused (409). Returns the path.
 */
export async function uploadObject(bucketName, path, userId, file) {
  const { config, gridfs } = bucket(bucketName);
  if (!isSafeOwnerStoragePath(path, userId)) {
    throw new HttpError('You can only upload files to your own workspace.', 403);
  }
  const contentType = String(file.mimetype || '')
    .split(';')[0]
    .trim();
  if (!config.mime.has(contentType)) {
    throw new HttpError(config.mimeError, 415);
  }
  if (!file.buffer?.length) throw new HttpError('The uploaded file is empty.', 400);
  if (!contentMatchesType(file.buffer, contentType)) {
    throw new HttpError(`${config.mimeError} This file's contents do not match its type.`, 415);
  }
  if (file.buffer.length > config.maxBytes) {
    throw new HttpError(config.sizeError, 413);
  }
  const s3 = s3For(bucketName);
  if (s3) {
    // Screenshot paths end in a random UUID, so this never replaces a file (no 409 check).
    await s3.client.send(
      new PutObjectCommand({
        Bucket: s3.bucket,
        Key: path,
        Body: file.buffer,
        ContentType: contentType,
      }),
    );
    return path;
  }
  const existing = await gridfs.find({ filename: path }).limit(1).toArray();
  if (existing.length) throw new HttpError('A file with this name already exists.', 409);
  await new Promise((resolve, reject) => {
    const stream = gridfs.openUploadStream(path, {
      metadata: { ownerId: userId, contentType },
    });
    stream.once('error', reject);
    stream.once('finish', resolve);
    stream.end(file.buffer);
  });
  return path;
}

/**
 * A read stream of the stored file with its byte length and content type, or null when no file
 * has that path. Nothing is read until the stream is consumed.
 */
export async function streamObject(bucketName, path) {
  const { gridfs } = bucket(bucketName);
  const s3 = s3For(bucketName);
  if (s3) {
    try {
      const object = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: path }));
      return {
        stream: object.Body,
        length: object.ContentLength,
        contentType: object.ContentType || '',
      };
    } catch (error) {
      // Not copied to S3 yet (scripts/migrate-screenshots-to-s3.js): serve it from GridFS.
      if (error.name !== 'NoSuchKey') throw error;
    }
  }
  const [file] = await gridfs.find({ filename: path }).limit(1).toArray();
  if (!file) return null;
  return {
    stream: gridfs.openDownloadStream(file._id),
    length: file.length,
    contentType: file.metadata?.contentType || '',
  };
}

/** The stored file's bytes and content type, or null when no file has that path. */
export async function downloadObject(bucketName, path) {
  const data = await streamObject(bucketName, path);
  if (!data) return null;
  const chunks = [];
  for await (const chunk of data.stream) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), contentType: data.contentType };
}

/** Returns the names actually removed, so callers can verify a cleanup. */
export async function removeObjects(bucketName, paths) {
  const { gridfs } = bucket(bucketName);
  const s3 = s3For(bucketName);
  // S3 reports every key it was given as deleted, so the GridFS copies below are listed already.
  const removed = s3 ? await s3Remove(s3, paths) : [];
  const files = await gridfs.find({ filename: { $in: paths } }).toArray();
  for (const file of files) {
    await gridfs.delete(file._id);
    if (!s3) removed.push({ name: file.filename });
  }
  return removed;
}

/** Total bytes stored in the member's `<userId>/` folder of a bucket. */
export async function ownerBytes(bucketName, userId) {
  const { config } = bucket(bucketName);
  const [row] = await nativeDb()
    .collection(`${config.name}.files`)
    .aggregate([
      { $match: { filename: { $regex: `^${userId}/` } } },
      { $group: { _id: null, bytes: { $sum: '$length' } } },
    ])
    .toArray();
  let s3Bytes = 0;
  const s3 = s3For(bucketName);
  // GridFS files not copied yet count too (copies count twice until the migration's --delete).
  if (s3)
    for await (const object of s3Objects(s3, { Prefix: `${userId}/` })) s3Bytes += object.Size;
  return (row?.bytes ?? 0) + s3Bytes;
}

/**
 * Oldest objects uploaded between `from` and the retention cutoff (temporary uploads; the
 * screenshot sweep walks its bucket in slices with `from`). S3 lists by name instead: the first
 * `limit` objects older than the cutoff whose names sort after `after`.
 */
export async function expiredObjects(bucketName, cutoff, limit, from = new Date(0), after = '') {
  const { gridfs } = bucket(bucketName);
  const s3 = s3For(bucketName);
  if (s3) {
    const objects = [];
    for await (const object of s3Objects(s3, { StartAfter: after || undefined })) {
      if (object.LastModified > cutoff) continue;
      const time = object.LastModified.toISOString();
      objects.push({ id: object.Key, name: object.Key, created_at: time, updated_at: time });
      if (objects.length === limit) break;
    }
    return objects;
  }
  const files = await gridfs
    .find({ uploadDate: { $gte: from, $lte: cutoff } })
    .sort({ uploadDate: 1 })
    .limit(limit)
    .toArray();
  return files.map((file) => ({
    id: String(file._id),
    name: file.filename,
    created_at: file.uploadDate.toISOString(),
    updated_at: file.uploadDate.toISOString(),
  }));
}

/** Deletes every file in the member's `<userId>/` folder of a bucket; returns how many. */
export async function removeOwnerFolder(bucketName, userId) {
  const { gridfs } = bucket(bucketName);
  let s3Count = 0;
  const s3 = s3For(bucketName);
  if (s3) {
    const keys = [];
    for await (const object of s3Objects(s3, { Prefix: `${userId}/` })) keys.push(object.Key);
    s3Count = (await s3Remove(s3, keys)).length;
  }
  // Owner ids are UUIDs (checked by isSafeOwnerStoragePath), so the prefix needs no escaping.
  const files = await gridfs.find({ filename: { $regex: `^${userId}/` } }).toArray();
  for (const file of files) await gridfs.delete(file._id);
  return s3Count + files.length;
}

/**
 * Copies every GridFS trade screenshot to S3 (skipping ones already there with the same size)
 * and checks each copy's size; with `remove`, then deletes the GridFS copy. Safe to stop and
 * re-run. Returns `{ copied, present, removed, failed }`.
 */
export async function migrateScreenshotsToS3({ remove = false, log = () => {} } = {}) {
  const s3 = s3For('trade-screenshots');
  if (!s3) throw new Error('Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY first.');
  const { gridfs } = bucket('trade-screenshots');
  const counts = { copied: 0, present: 0, removed: 0, failed: 0 };
  let last = null;
  for (;;) {
    // Short pages by _id rather than one long cursor, which a slow copy could let time out.
    const files = await gridfs
      .find(last ? { _id: { $gt: last } } : {})
      .sort({ _id: 1 })
      .limit(100)
      .toArray();
    if (!files.length) break;
    for (const file of files) {
      try {
        if ((await s3Size(s3, file.filename)) === file.length) {
          counts.present += 1;
        } else {
          const chunks = [];
          for await (const chunk of gridfs.openDownloadStream(file._id)) chunks.push(chunk);
          await s3.client.send(
            new PutObjectCommand({
              Bucket: s3.bucket,
              Key: file.filename,
              Body: Buffer.concat(chunks),
              ContentType: file.metadata?.contentType || undefined,
            }),
          );
          if ((await s3Size(s3, file.filename)) !== file.length) {
            throw new Error('the copy in S3 has a different size');
          }
          counts.copied += 1;
        }
        if (remove) {
          await gridfs.delete(file._id);
          counts.removed += 1;
        }
      } catch (error) {
        counts.failed += 1;
        log(`Failed ${file.filename}: ${error.message}`);
      }
    }
    last = files.at(-1)._id;
    log(`${counts.copied} copied, ${counts.present} already in S3, ${counts.failed} failed so far`);
  }
  return counts;
}
