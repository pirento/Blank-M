/**
 * Structured logging. In production each line is one JSON object
 * (time, level, scope, msg and any fields) that log tools such as PM2, Docker
 * or a hosted log service can search; in development lines stay readable.
 *
 * LOG_LEVEL: debug | info | warn | error (default info). LOG_FORMAT: json | text
 * (default json in production, text otherwise). Never log secrets, tokens,
 * passwords, request bodies or AI prompts.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function settings() {
  const production = process.env.NODE_ENV === 'production';
  return {
    // Tests only show warnings and errors unless LOG_LEVEL says otherwise.
    threshold:
      LEVELS[process.env.LOG_LEVEL] ??
      (process.env.NODE_ENV === 'test' ? LEVELS.warn : LEVELS.info),
    json: process.env.LOG_FORMAT ? process.env.LOG_FORMAT === 'json' : production,
  };
}

function write(level, scope, msg, fields = {}) {
  const { threshold, json } = settings();
  if (LEVELS[level] < threshold) return;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (json) {
    stream.write(
      `${JSON.stringify({ time: new Date().toISOString(), level, scope, msg, ...fields })}\n`,
    );
    return;
  }
  const extra = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  stream.write(`[${scope}] ${msg}${extra ? ` ${extra}` : ''}\n`);
}

/** A logger for one area of the app, e.g. createLogger('ai').warn('usage record failed'). */
export function createLogger(scope) {
  return {
    debug: (msg, fields) => write('debug', scope, msg, fields),
    info: (msg, fields) => write('info', scope, msg, fields),
    warn: (msg, fields) => write('warn', scope, msg, fields),
    error: (msg, fields) => write('error', scope, msg, fields),
  };
}

/** The error's class name only: messages can contain user data or provider details. */
export const errorName = (error) => (error instanceof Error ? error.name : typeof error);
