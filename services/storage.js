/**
 * File storage in MongoDB GridFS: statements, temporary voice notes and trade
 * chart screenshots, each in the owner's folder.
 */
import { randomUUID } from 'node:crypto';
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

/** Same naming as the original client upload: `<owner>/<time>-<safe name>`. */
export function statementPath(userId, originalName) {
  const safeName = String(originalName || 'statement')
    .replace(/[^\w.-]/g, '_')
    .slice(-80);
  return `${userId}/${Date.now()}-${safeName}`;
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

/** The stored file's bytes and content type, or null when no file has that path. */
export async function downloadObject(bucketName, path) {
  const { gridfs } = bucket(bucketName);
  const [file] = await gridfs.find({ filename: path }).limit(1).toArray();
  if (!file) return null;
  const chunks = [];
  await new Promise((resolve, reject) => {
    gridfs
      .openDownloadStream(file._id)
      .on('data', (chunk) => chunks.push(chunk))
      .once('error', reject)
      .once('end', resolve);
  });
  return { buffer: Buffer.concat(chunks), contentType: file.metadata?.contentType || '' };
}

/** Returns the names actually removed, so callers can verify a cleanup. */
export async function removeObjects(bucketName, paths) {
  const { gridfs } = bucket(bucketName);
  const files = await gridfs.find({ filename: { $in: paths } }).toArray();
  const removed = [];
  for (const file of files) {
    await gridfs.delete(file._id);
    removed.push({ name: file.filename });
  }
  return removed;
}

/** Oldest objects past the retention cutoff (temporary voice notes). */
export async function expiredObjects(bucketName, cutoff, limit) {
  const { gridfs } = bucket(bucketName);
  const files = await gridfs
    .find({ uploadDate: { $lte: cutoff } })
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
