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
  for (const path of ['/terms', '/privacy', '/disclaimer', '/refunds', '/contact']) {
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
  await signIn(page, MEMBERS.smoke);
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
  await signIn(page, MEMBERS.smoke);
  await expect(page.locator('.workspace-avatar')).toHaveText('EE');
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

test('the live chart draws candles with a legend and intervals', async ({ page }) => {
  const errors = trackErrors(page);
  const start = Date.UTC(2026, 9, 19, 3, 45);
  // Fixed candles, so the test does not depend on a market data provider.
  await page.route('**/api/history?**', (route) => {
    const symbol = new URL(route.request().url()).searchParams.get('symbol');
    const candles = Array.from({ length: 60 }, (_, index) => {
      const open = 1400 + Math.sin(index / 4) * 12;
      const close = open + Math.cos(index / 3) * 6;
      return {
        time: start + index * 5 * 60_000,
        open,
        close,
        high: Math.max(open, close) + 3,
        low: Math.min(open, close) - 3,
        volume: 1000 + index * 10,
      };
    });
    return route.fulfill({ json: { symbol, source: 'yahoo', currency: 'INR', candles } });
  });
  await signIn(page, MEMBERS.smoke);
  await page.goto('/chart?symbol=RELIANCE');
  await expect(page.locator('.pro-chart canvas').first()).toBeVisible();
  await expect(page.locator('.pro-chart-legend')).toContainText('RELIANCE');
  await expect(page.getByRole('status').filter({ hasText: 'times in IST' })).toBeVisible();
  await page.getByRole('button', { name: '1H' }).click();
  await expect(page.getByRole('button', { name: '1H' })).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});
