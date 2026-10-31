/**
 * Builds the Express application: security headers, sessions, body parsing,
 * static files, EJS views, routes and error handling. server.js starts it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { env } from './config/env.js';
import { sessionMiddleware } from './middleware/session.js';
import { csrfProtection, privateApiResponse, securityHeaders } from './middleware/security.js';
import { loadAuth } from './middleware/auth.js';
import { errorHandler, notFoundApi } from './middleware/errors.js';
import { requestLog } from './middleware/request-log.js';
import { viewHelpers } from './middleware/view-helpers.js';
import { iconSprite } from './services/icons.js';
import apiRoutes from './routes/api.js';
import authRoutes from './routes/auth.js';
import webRoutes from './routes/web.js';
import adminRoutes from './routes/admin.js';

const root = path.dirname(fileURLToPath(import.meta.url));
/** Direct dependencies only; pnpm links each one under node_modules/<name>. */
const packageDirectory = (name) => path.join(root, 'node_modules', name);

/**
 * Express application (MVC): routes → controllers → services/models, with EJS
 * views. Exported as a factory so tests can mount it against a temporary database.
 */
export function createApp({ sessionStore } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  if (env.trustProxy) app.set('trust proxy', env.trustProxy);

  app.use(securityHeaders);

  // The service worker must always be revalidated, so updates reach installed apps.
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('text/javascript').sendFile(path.join(root, 'public/sw.js'));
  });
  app.get('/manifest.webmanifest', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/manifest+json').sendFile(path.join(root, 'public/manifest.webmanifest'));
  });
  const staticOptions = { maxAge: env.isProduction ? '1h' : 0, index: false };
  // Modules and styles have unversioned URLs: revalidate each load (a 304 via ETag), so a page
  // never mixes HTML from one deploy with scripts from another.
  const revalidate = (res) => res.setHeader('Cache-Control', 'no-cache');
  const codeOptions = { ...staticOptions, setHeaders: revalidate };
  app.use(
    express.static(path.join(root, 'public'), {
      ...staticOptions,
      setHeaders: (res, file) => /\.(m?js|css)$/.test(file) && revalidate(res),
    }),
  );
  app.use('/shared', express.static(path.join(root, 'shared'), codeOptions));
  app.use('/vendor/zod', express.static(packageDirectory('zod'), codeOptions));
  const vendorFiles = {
    'chart.umd.min.js': path.join(packageDirectory('chart.js'), 'dist/chart.umd.min.js'),
    'jspdf.umd.min.js': path.join(packageDirectory('jspdf'), 'dist/jspdf.umd.min.js'),
    'html-to-image.js': path.join(packageDirectory('html-to-image'), 'dist/html-to-image.js'),
    'marked.esm.js': path.join(packageDirectory('marked'), 'lib/marked.esm.js'),
    'purify.es.mjs': path.join(packageDirectory('dompurify'), 'dist/purify.es.mjs'),
    'lightweight-charts.js': path.join(
      packageDirectory('lightweight-charts'),
      'dist/lightweight-charts.standalone.production.js',
    ),
  };
  app.get('/vendor/:file', (req, res, next) => {
    const file = vendorFiles[req.params.file];
    if (!file) return next();
    // `.mjs` must be served as JavaScript for browsers to accept the module.
    if (/\.m?js$/.test(file)) res.type('text/javascript');
    res.sendFile(file, { maxAge: staticOptions.maxAge });
  });
  app.get('/icons.svg', (_req, res) => {
    res.type('image/svg+xml').setHeader('Cache-Control', 'public, max-age=3600');
    res.send(iconSprite());
  });

  // Logged after static files, so only pages and API calls appear in the log.
  app.use(requestLog);
  app.use('/api', privateApiResponse);
  // The Kite callback and Google OAuth return use GET with query strings only.
  app.use(
    express.json({
      limit: '2mb',
      // Payment webhooks are verified against the exact bytes Razorpay signed.
      verify: (req, _res, buffer) => {
        if (req.originalUrl === '/api/billing/razorpay/webhook') req.rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(sessionMiddleware({ store: sessionStore }));
  app.use(csrfProtection);
  app.use(loadAuth);
  app.use(viewHelpers);

  app.use('/api', apiRoutes);
  app.use('/api', notFoundApi);
  app.use('/auth', authRoutes);
  app.use('/admin', adminRoutes);
  app.use('/', webRoutes);
  app.use(errorHandler);
  return app;
}
