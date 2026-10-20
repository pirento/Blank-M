import { expect, test } from '@playwright/test';
import { MEMBERS, signIn, signInWithAuthenticator, trackErrors } from './helpers.js';

test('administrators sign in with Google and an authenticator; every admin page opens', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/login$/);
  // Administrators sign in with Google and then their authenticator code.
  await signInWithAuthenticator(page);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator('[data-admin-dashboard]')).toContainText('Members');
  await expect(page.locator('[data-admin-dashboard]')).toContainText('Integrations');

  const pages = [
    ['/admin/members', '[data-members]', 'Members'],
    ['/admin/billing', '[data-admin-billing]', 'Premium plan'],
    ['/admin/integrations', '[data-admin-integrations]', 'Zerodha Kite'],
    ['/admin/ai', '[data-admin-ai]', ''],
    ['/admin/audit', '[data-admin-audit]', ''],
  ];
  for (const [path, selector, text] of pages) {
    await page.goto(path);
    await expect(page.locator(selector)).toBeVisible();
    if (text) await expect(page.locator('main')).toContainText(text);
  }
  expect(errors).toEqual([]);
});

test('members cannot see the admin panel', async ({ page }) => {
  await signIn(page, MEMBERS.smoke);
  const response = await page.goto('/admin');
  expect(response.status()).toBe(404);
});
