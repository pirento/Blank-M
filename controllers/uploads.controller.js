/**
 * File uploads: broker statements, temporary voice notes, trade chart
 * screenshots and Excel workbook parsing for the import page.
 */
import { reserveAttempts } from '../services/rate-window.js';
import multer from 'multer';
import readXlsxFile from 'read-excel-file/node';
import { normalizeSheet } from '../shared/spreadsheet-data.js';
import {
  downloadObject,
  removeObjects,
  statementPath,
  uploadObject,
  voiceNotePath,
} from '../services/storage.js';
import {
  attachTradeScreenshot,
  removeTradeScreenshot,
  tradeScreenshot,
} from '../services/journal/workspace.js';
import { isSafeOwnerStoragePath } from '../services/storage-path.js';
import { HttpError } from '../services/errors.js';

const MAX_BYTES = 10 * 1024 * 1024;

/** In-memory single-file parser; files never touch the server's disk. */
export const singleFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 4 },
}).single('file');

/** Per member: at most 60 uploads an hour across statements, voice notes and screenshots. */
async function requireFile(req) {
  if (!req.file) throw new HttpError('Choose a file to upload.', 400);
  const quota = await reserveAttempts(
    [{ key: `uploads:${req.member.userId}`, limit: 60 }],
    60 * 60_000,
  );
  if (!quota.allowed) throw new HttpError('Too many uploads. Try again later.', 429);
  return req.file;
}

/** Uploads an attachment for AI analysis into the owner's private `statements` folder. */
export async function uploadStatement(req, res) {
  const file = await requireFile(req);
  const path = statementPath(req.member.userId, file.originalname);
  await uploadObject('statements', path, req.member.userId, file);
  res.status(201).json({ path });
}

/**
 * POST /api/uploads/voice-notes (multipart file): stores a temporary voice note for transcription
 * and returns its audioPath, filename and MIME type without parameters (201).
 */
export async function uploadVoiceNote(req, res) {
  const file = await requireFile(req);
  const { path, filename } = voiceNotePath(req.member.userId, file.originalname);
  const mime = String(file.mimetype || 'audio/webm')
    .split(';')[0]
    .trim();
  await uploadObject('voice-notes', path, req.member.userId, { ...file, mimetype: mime });
  res.status(201).json({ audioPath: path, filename, mime });
}

/** Temporary voice-note cleanup by its owner; the server also removes it after transcription. */
export async function removeVoiceNote(req, res) {
  const path = String(req.body?.path ?? '');
  if (!isSafeOwnerStoragePath(path, req.member.userId)) {
    throw new HttpError('You can only remove files from your own workspace.', 403);
  }
  await removeObjects('voice-notes', [path]);
  res.json({ ok: true });
}

/** Reads an .xlsx workbook into normalized sheets. Nothing is stored. */
export async function parseWorkbook(req, res) {
  const file = await requireFile(req);
  if (!/\.xlsx$/i.test(file.originalname || '')) {
    throw new HttpError(
      'Legacy .xls files must first be saved as .xlsx or CSV before importing.',
      415,
    );
  }
  let result;
  try {
    result = await readXlsxFile(file.buffer, { parseNumber: (value) => value });
  } catch {
    throw new HttpError(
      'Could not read this Excel file. Save it as an unencrypted .xlsx workbook or CSV.',
      422,
    );
  }
  if (result.length > 30) throw new HttpError('Use a workbook with at most 30 sheets.', 422);
  try {
    res.json({ sheets: result.map((sheet) => normalizeSheet(sheet.sheet, sheet.data)) });
  } catch (error) {
    throw new HttpError(
      error instanceof Error ? error.message : 'Could not read the workbook.',
      422,
    );
  }
}

/* ------------------------------ trade screenshots ------------------------------ */

/** POST /api/trades/:id/screenshot (multipart file): attaches or replaces the chart image; 201 with the trade. */
export async function uploadTradeScreenshot(req, res) {
  const file = await requireFile(req);
  res.status(201).json({
    trade: await attachTradeScreenshot(req.member.userId, req.params.id, file),
  });
}

/** Streams the owner's screenshot (API responses are private and not cached). */
export async function getTradeScreenshot(req, res) {
  const path = await tradeScreenshot(req.member.userId, req.params.id);
  const data = path ? await downloadObject('trade-screenshots', path) : null;
  if (!data) throw new HttpError('This trade has no screenshot.', 404);
  res.type(data.contentType).send(data.buffer);
}

/** DELETE /api/trades/:id/screenshot: removes the trade's screenshot and returns the updated trade. */
export async function deleteTradeScreenshot(req, res) {
  res.json({ trade: await removeTradeScreenshot(req.member.userId, req.params.id) });
}
