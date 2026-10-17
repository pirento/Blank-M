/**
 * Loads .env and checks the runtime configuration needed in production.
 */
import { config } from 'dotenv';

config({ path: ['.env.local', '.env.development.local', '.env'], override: false, quiet: true });

const truthy = (value) => /^(1|true)$/i.test(String(value ?? '').trim());

/** Runtime settings. Secrets are read lazily by the services that need them. */
export const env = {
  get nodeEnv() {
    return process.env.NODE_ENV || 'development';
  },
  get isProduction() {
    return process.env.NODE_ENV === 'production';
  },
  get port() {
    return Number(process.env.PORT ?? 3000);
  },
  get host() {
    return process.env.HOST ?? '0.0.0.0';
  },
  get mongoUri() {
    return process.env.MONGODB_URI?.trim() || 'mongodb://127.0.0.1:27017/blank';
  },
  get sessionSecret() {
    return process.env.SESSION_SECRET?.trim() || '';
  },
  get appUrl() {
    return process.env.APP_URL?.trim() || '';
  },
  get googleAuthEnabled() {
    return (
      truthy(process.env.GOOGLE_AUTH_ENABLED) &&
      Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim())
    );
  },
  get trustProxy() {
    return truthy(process.env.TRUST_PROXY);
  },
};

/** Fail fast on configuration that would make sessions forgeable in production. */
export function assertRuntimeConfiguration() {
  if (env.isProduction && env.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 random characters in production.');
  }
}
