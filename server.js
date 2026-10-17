/**
 * Node entry point: connects MongoDB, then serves the app (see app.js).
 */
import { assertRuntimeConfiguration, env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { createApp } from './app.js';
import { hasOpenAiKey } from './services/ai/openai-key.js';
import { ensureAiConfiguration } from './services/ai/config.js';
import { createLogger } from './services/logger.js';

const log = createLogger('server');

/** Node entry point: connect MongoDB, then serve the EJS application and JSON API. */
async function start() {
  assertRuntimeConfiguration();
  await connectDatabase();
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
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 30_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

// A crash leaves the process in an unknown state: log it and let PM2/Docker restart it.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', { reason: reason?.stack ?? String(reason) });
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception', { reason: error?.stack ?? String(error) });
  process.exit(1);
});

start().catch((error) => {
  log.error(
    'Failed to start Blank server. Check MongoDB, runtime configuration and port availability.',
    { reason: error?.message ?? '' },
  );
  // Exit even if MongoDB is still connected, so the supervisor restarts us.
  process.exit(1);
});
