/**
 * Node entry point: connects MongoDB, then serves the app (see app.js).
 */
import { assertRuntimeConfiguration, env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { createApp } from './app.js';
import { endLiveQuoteStreams } from './controllers/market.controller.js';
import { hasOpenAiKey } from './services/ai/openai-key.js';
import { ensureAiConfiguration } from './services/ai/config.js';
import { createLogger } from './services/logger.js';
import { startAnnouncementResumer } from './services/admin/announcements.js';
import {
  applyPlatformSettings,
  startPlatformSettingsRefresh,
} from './services/platform/settings.js';

const log = createLogger('server');

// Replaced by the graceful shutdown once the server is listening.
let shutdown = (code) => process.exit(code);

/** Node entry point: connect MongoDB, then serve the EJS application and JSON API. */
async function start() {
  assertRuntimeConfiguration();
  await connectDatabase();
  // API keys saved in the admin panel override .env; keep them in step every minute.
  await applyPlatformSettings();
  startPlatformSettingsRefresh();
  // Finishes an announcement a restart interrupted (one process takes it, by lease).
  startAnnouncementResumer();
  await ensureAiConfiguration();
  const app = createApp();
  const server = app.listen(env.port, env.host, () => {
    log.info(`Blank server running on http://${env.host}:${env.port}`);
    if (!hasOpenAiKey()) {
      log.warn('No OpenAI API key is set. AI features are unavailable.');
    }
    if (env.isProduction && !env.trustProxy) {
      log.warn(
        'Production session cookies are Secure. Behind an HTTPS proxy, set TRUST_PROXY=true or sign-in will fail.',
      );
    }
    if (!env.sessionSecret) {
      log.warn('SESSION_SECRET is not set. Using a development-only secret.');
    }
  });
  // Outlive Nginx's idle upstream connections (60 s), so it never reuses a socket Node just closed.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  let stopping = false;
  shutdown = (code) => {
    if (stopping) return;
    stopping = true;
    endLiveQuoteStreams();
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(code));
    });
    setTimeout(() => process.exit(1), 30_000).unref();
  };
  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));
}

// A crash leaves the process in an unknown state: log it, finish the requests in flight and let
// PM2/Docker restart it.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', { reason: reason?.stack ?? String(reason) });
  shutdown(1);
});
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception', { reason: error?.stack ?? String(error) });
  shutdown(1);
});

start().catch((error) => {
  log.error(
    'Failed to start Blank server. Check MongoDB, runtime configuration and port availability.',
    { reason: error?.message ?? '' },
  );
  // Exit even if MongoDB is still connected, so the supervisor restarts us.
  process.exit(1);
});
