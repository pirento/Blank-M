import { expect, test } from '@playwright/test';
import { ADMIN, MEMBERS, signIn, trackErrors } from './helpers.js';

test('the admin panel has its own sign-in and every page opens without errors', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.fill('#admin-email', ADMIN.email);
  await page.fill('#admin-password', ADMIN.password);
  await page.getByRole('button', { name: 'Sign in to the admin panel' }).click();
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
