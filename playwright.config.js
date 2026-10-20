import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against the real app running on an in-memory MongoDB
 * (scripts/dev-memory.js seeds admin@example.com / blank-local-admin).
 * Tests share one database, so they run in a single worker and create
 * their own uniquely named records.
 */
const PORT = Number(process.env.E2E_PORT || 3456);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/dev-memory.js',
    url: `http://localhost:${PORT}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      NODE_ENV: 'development',
      OPENAI_API_KEY: '',
      // Keep in sync with MEMBERS in tests/e2e/helpers.js.
      E2E_MEMBERS: ['account', 'journal', 'plans', 'smoke', 'settings']
        .map((name) => `e2e-${name}@example.com`)
        .join(','),
      // Fake Google sign-in for the tests (see scripts/dev-memory.js).
      E2E_GOOGLE_STUB: '1',
      // Keep in sync with MFA_ADMIN in tests/e2e/helpers.js.
      E2E_MFA_ADMIN: 'e2e-mfa-admin@example.com:JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    },
  },
});
