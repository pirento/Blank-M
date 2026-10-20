import { expect, test } from '@playwright/test';
import {
  MEMBERS,
  WORKSPACE_PAGES,
  expectNoHorizontalOverflow,
  signIn,
  trackErrors,
} from './helpers.js';

test('public pages render', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(page.locator('body')).toContainText('Blank');
  await page.goto('/login');
  await expect(page.locator('#email')).toBeVisible();
  await page.goto('/login?mode=reset');
  await expect(page.locator('[data-reset-unavailable]')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/terms', '/privacy', '/refunds', '/contact']) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  expect(errors).toEqual([]);
});

test('signed-out visitors are sent to the login page', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
});

test('every workspace page loads without errors on desktop and phone', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  for (const path of WORKSPACE_PAGES) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(path);
    await expect(
      page.locator('main, [data-calculator], .chat-reference, .admin-reference').first(),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page);
  }
  expect(errors).toEqual([]);
});

test('topbar shows initials and market status; command palette opens', async ({ page }) => {
  await signIn(page);
  await expect(page.locator('.workspace-avatar')).toHaveText('AD');
  await expect(page.locator('[data-market-status] b')).toHaveText(/open|closed|weekend|holiday/);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
});

test('wrong password shows an error and sign out ends the session', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', MEMBERS.smoke.email);
  await page.fill('#password', 'not-the-password');
  await page.click('button[type=submit]');
  await expect(page.locator('[data-login-error]')).toBeVisible();
  await signIn(page, MEMBERS.smoke);
  await page.click('[data-open-menu]');
  await page.locator('[data-sign-out]').first().click();
  await expect(page).toHaveURL(/\/login/);
});
