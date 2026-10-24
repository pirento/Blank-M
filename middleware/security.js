/**
 * Security middleware: response headers (CSP with nonce), private API caching
 * rules and CSRF protection for state-changing requests.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../services/errors.js';

/** Conservative headers for every response; scripts must be same-origin modules. */
export function securityHeaders(req, res, next) {
  res.locals.cspNonce = randomBytes(16).toString('base64');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  // Browsers only honour HSTS over HTTPS; TLS ends at the proxy in production.
  if (process.env.NODE_ENV === 'production' && /^https:/i.test(process.env.APP_URL ?? '')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (!req.path.startsWith('/prototype/')) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${res.locals.cspNonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self' https://kite.zerodha.com https://accounts.google.com",
        "object-src 'none'",
      ].join('; '),
    );
  }
  next();
}

/** API responses are private and never cached. */
export function privateApiResponse(_req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ANONYMOUS_SESSION_MS = 2 * 60 * 60_000;
/** Endpoints authorized by something other than the session cookie. */
const CSRF_EXEMPT = new Set([
  '/api/maintenance/voice-notes',
  '/api/maintenance/weekly-reports',
  '/api/maintenance/price-checks',
  '/api/maintenance/daily-import',
  '/api/billing/razorpay/webhook',
  '/api/maintenance/premarket-plan',
  '/api/telegram/webhook',
  '/api/invitations/accept',
]);

function sameToken(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string' || !expected || !received)
    return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Synchronizer-token CSRF protection for every state-changing request that
 * relies on the session cookie. Tokens arrive in a header (fetch) or `_csrf` field.
 */
export function csrfProtection(req, res, next) {
  // Only pages hand a token to the browser. Creating one marks the session as
  // changed and stores it, so API calls, webhooks, cron jobs, health checks and
  // HEAD probes must not mint one.
  const isPage = req.method === 'GET' && !req.path.startsWith('/api/');
  if (req.session && isPage && !req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString('base64url');
    // Crawlers and visitors who never sign in keep it 2 hours, not a week; login regenerates it.
    if (!req.session.auth) req.session.cookie.maxAge = ANONYMOUS_SESSION_MS;
  }
  res.locals.csrfToken = req.session?.csrfToken ?? '';
  if (SAFE_METHODS.has(req.method) || CSRF_EXEMPT.has(req.path)) return next();
  const received = req.get('x-csrf-token') || req.body?._csrf;
  if (!req.session || !sameToken(req.session.csrfToken, received)) {
    return next(
      new HttpError('Your form expired. Reload the page and try again.', 403, { code: 'csrf' }),
    );
  }
  next();
}
