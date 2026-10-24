/**
 * Final error handling for JSON API and pages, without leaking internal details.
 */
import { z } from 'zod';
import { HttpError, ServerConfigurationError } from '../services/errors.js';
import { createLogger, errorName } from '../services/logger.js';

const log = createLogger('server');

function statusOf(error) {
  if (error instanceof z.ZodError) return 400;
  if (error instanceof ServerConfigurationError) return 503;
  const status = Number(error?.status ?? error?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
}

/** Body-parser failures, explicit HTTP errors and unexpected failures, without leaking details. */
export function errorHandler(error, req, res, _next) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const type = error?.type;
  let status = statusOf(error);
  let message;
  if (type === 'entity.too.large') {
    status = 413;
    message = 'Request body is too large.';
  } else if (type === 'entity.parse.failed') {
    status = 400;
    message = 'Request body must contain valid JSON.';
  } else if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
    status = 415;
    message = 'Request encoding is not supported.';
  } else if (error?.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    // Limits differ per upload (10 MB files, 25 MB backups) and multer does not report which.
    message = 'The file is too large for this upload.';
  } else if (error?.name === 'MulterError') {
    // Wrong field name, too many files and similar upload mistakes are the client's.
    status = 400;
    message = 'The upload was not in the expected form. Choose one file and try again.';
  } else if (error instanceof z.ZodError) {
    message = `Invalid request: ${error.issues[0]?.message || 'bad payload'}`;
  } else if (error instanceof ServerConfigurationError) {
    message = 'This integration is not configured yet.';
  } else if (status < 500 || error instanceof HttpError) {
    message = error.message;
  } else {
    message = 'Unexpected server error';
  }
  if (status >= 500 && !(error instanceof HttpError)) {
    // The stack stays in the server log; the client only sees the generic message.
    log.error('unexpected request failure', {
      error: errorName(error),
      stack: error?.stack,
      requestId: res.locals.requestId,
    });
  }
  if (error?.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
  const wantsJson =
    req.path.startsWith('/api/') ||
    req.xhr ||
    (req.get('accept') || '').includes('application/json') ||
    req.get('content-type')?.includes('application/json');
  if (wantsJson) {
    const body = { error: message };
    for (const key of [
      'workspaceAccessRevoked',
      'authBanStatus',
      'retryable',
      'requiresReview',
      'outcome',
      'fieldErrors',
      'code',
      'feature',
    ]) {
      if (error?.[key] !== undefined) body[key] = error[key];
    }
    res.status(status).json(body);
    return;
  }
  res.status(status).render('pages/error', { title: 'Error', status, message });
}

/** JSON 404 for any /api path no route matched. */
export function notFoundApi(_req, res) {
  res.status(404).json({ error: 'Unknown API endpoint' });
}
