import { expect } from '@playwright/test';

export const ADMIN = { email: 'admin@example.com', password: 'blank-local-admin' };

/**
 * Members seeded by scripts/dev-memory.js (see E2E_MEMBERS in playwright.config.js).
 * Sign-in is limited to 10 attempts per account per 15 minutes, so each spec file
 * uses its own account and only tests that need administration sign in as ADMIN.
 */
/** An administrator with a verified authenticator (E2E_MFA_ADMIN in playwright.config.js). */
export const MFA_ADMIN = {
  email: 'e2e-mfa-admin@example.com',
  password: ADMIN.password,
  secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
};

export const MEMBERS = {
  account: { email: 'e2e-account@example.com', password: ADMIN.password },
  journal: { email: 'e2e-journal@example.com', password: ADMIN.password },
  plans: { email: 'e2e-plans@example.com', password: ADMIN.password },
  smoke: { email: 'e2e-smoke@example.com', password: ADMIN.password },
  settings: { email: 'e2e-settings@example.com', password: ADMIN.password },
};

/** Every workspace page, used by the smoke test. */
export const WORKSPACE_PAGES = [
  '/dashboard',
  '/today',
  '/watchlist',
  '/calculator',
  '/orders',
  '/transactions',
  '/journal',
  '/import',
  '/backtest',
  '/rules',
  '/insights',
  '/tax',
  '/paper',
  '/options',
  '/strategy',
  '/reports',
  '/analytics',
  '/settings',
  '/billing',
  '/chart',
];

/** A short unique suffix so repeated runs never collide in the shared database. */
export const unique = () => Math.random().toString(36).slice(2, 8);

export async function signIn(page, { email, password } = ADMIN) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard');
}

/** Signs in as MFA_ADMIN and completes the authenticator check. */
export async function signInWithAuthenticator(page) {
  const { currentStep, totpCode } = await import('../../services/auth/totp.js');
  await page.goto('/login');
  await page.fill('#email', MFA_ADMIN.email);
  await page.fill('#password', MFA_ADMIN.password);
  await page.click('button[type=submit]');
  await page.fill('#mfa-signin-code', totpCode(MFA_ADMIN.secret, currentStep()));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  // The challenge is shown at /dashboard itself; it goes away once the code is accepted.
  await page.waitForSelector('#mfa-signin-code', { state: 'detached' });
}

/** Collect uncaught page errors and console errors (except expected HTTP 4xx noise). */
export function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });
  return errors;
}

/** Same-origin JSON request with the page's CSRF token (for fast test setup). */
export async function apiRequest(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': document.querySelector('meta[name=csrf-token]').content,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    { method, path, body },
  );
}

export async function expectNoHorizontalOverflow(page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewport = page.viewportSize().width;
  expect(width, 'page should not scroll sideways').toBeLessThanOrEqual(viewport + 2);
}
