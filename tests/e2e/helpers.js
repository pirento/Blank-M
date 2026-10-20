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

/**
 * Signs in "with Google" as `email` (Google's page is faked here; scripts/dev-memory.js fakes its
 * API), starting from `start` (the admin or member sign-in).
 */
export async function signInWithGoogle(page, email, start = '/admin/login') {
  // Our /auth/google answers with a redirect to Google; send the browser straight back to the
  // callback instead, as Google would after the person chose their account.
  await page.route('**/auth/google?**', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const asked = new URL(response.headers().location);
    const back = new URL(asked.searchParams.get('redirect_uri'));
    back.searchParams.set('state', asked.searchParams.get('state'));
    back.searchParams.set('code', email);
    await route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  await page.goto(start);
  await page.getByRole('link', { name: /with Google/ }).click();
}

let lastUsedStep = 0;

/** Signs in as MFA_ADMIN the administrators' way: Google, then the authenticator code. */
export async function signInWithAuthenticator(page) {
  const { currentStep, totpCode } = await import('../../services/auth/totp.js');
  await signInWithGoogle(page, MFA_ADMIN.email);
  // A code is accepted once: when an earlier test used this 30-second step, wait for the next one.
  while (currentStep() <= lastUsedStep) await page.waitForTimeout(1000);
  lastUsedStep = currentStep();
  await page.fill('#mfa-signin-code', totpCode(MFA_ADMIN.secret, lastUsedStep));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  // The challenge is shown in place; it goes away once the code is accepted.
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
