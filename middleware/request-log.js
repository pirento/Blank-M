/**
 * One log line per request (method, path, status, duration) with a request ID
 * that is also returned in the X-Request-Id header, so a member can quote it
 * and the matching server log can be found. Query strings and bodies are never
 * logged.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '../services/logger.js';

const log = createLogger('http');
// Reuse a well-formed ID set by the proxy (see deploy/nginx.conf.example).
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Assigns the request ID (res.locals.requestId) and logs the request when the response finishes. */
export function requestLog(req, res, next) {
  const incoming = req.get('x-request-id');
  const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  // Read now: routers rewrite req.url while handling the request.
  // Share-link tokens are credentials: never write them to the log.
  const path = req.originalUrl.split('?')[0].replace(/^\/share\/[^/]+/, '/share/:token');
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const fields = {
      method: req.method,
      path,
      status: res.statusCode,
      ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      requestId,
    };
    if (res.statusCode >= 500) log.error('request', fields);
    else log.info('request', fields);
  });
  next();
}
