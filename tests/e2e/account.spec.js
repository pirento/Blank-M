import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { MEMBERS, apiRequest, signIn, signInWithAuthenticator, unique } from './helpers.js';

test('charge rates persist and a backup downloads and restores', async ({ page }) => {
  await signIn(page, MEMBERS.account);
  await page.goto('/settings');
  await page.fill('#charge-brokeragePercent', '0.05');
  await page.getByRole('button', { name: 'Save charges' }).click();
  await page.reload();
  await expect(page.locator('#charge-brokeragePercent')).toHaveValue('0.05');

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download backup' }).click();
  const file = await (await download).path();
  const backup = JSON.parse(await readFile(file, 'utf8'));
  expect(backup.format).toBe('pirento-blank-backup');

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Restore from backup' }).click();
  await (await chooser).setFiles(file);
  await expect(page.locator('[data-backup]')).toContainText('already present');
});

test('signing out other devices ends their sessions', async ({ page, browser }) => {
  await signIn(page, MEMBERS.account);
  const other = await (await browser.newContext()).newPage();
  await signIn(other, MEMBERS.account);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out all other devices' }).click();
  await expect(page.locator('[data-sessions]')).toContainText('This device');
  await other.goto('/dashboard');
  await expect(other).toHaveURL(/\/login/);
});

test('invite a member with a private link, then reset their password and suspend them', async ({
  page,
  browser,
}) => {
  const email = `member-${unique()}@example.com`;
  // Reset links and suspending need an administrator who has verified an authenticator.
  await signInWithAuthenticator(page);
  await page.goto('/admin/members');
  await page.fill('#manual-invite-email', email);
  await page.getByRole('button', { name: 'Create private invitation' }).click();
  const link = await page.inputValue('#manual-invite-link');

  const member = await (await browser.newContext()).newPage();
  await member.goto(link);
  await member.fill('#invitation-password', 'first-password-12345');
  await member.click('button[type=submit]');
  await expect(member.locator('[data-invitation-accepted]')).toBeVisible();

  await page.click('[data-refresh-all]');
  const row = page.locator('[data-members] .admin-reference-row', { hasText: email });
  await row.getByRole('button', { name: 'Reset link' }).click();
  const reset = await page.inputValue('#reset-link');
  await page.getByRole('button', { name: 'Done' }).click();

  const resetPage = await (await browser.newContext()).newPage();
  await resetPage.goto(reset);
  await resetPage.waitForURL('**/login?mode=recover');
  await resetPage.fill('input[type=password]', 'second-password-6789');
  await resetPage.click('button[type=submit]');
  await resetPage.waitForURL('**/dashboard');

  await row.getByRole('button', { name: 'Suspend' }).click();
  await page.getByRole('button', { name: 'Confirm access change' }).click();
  await expect(
    page.locator('[data-members] .admin-reference-row', { hasText: email }),
  ).toContainText('revoked');
  await resetPage.goto('/dashboard');
  await expect(resetPage).toHaveURL(/\/login/);
});

test('price alerts can be added and removed, and the app is installable', async ({ page }) => {
  await signIn(page, MEMBERS.account);
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).icons.length).toBeGreaterThan(1);
  const worker = await page.request.get('/sw.js');
  expect(worker.headers()['cache-control']).toBe('no-cache');

  await page.goto('/watchlist');
  const panel = page
    .getByRole('region', { name: 'Price alerts' })
    .or(page.locator('[data-alerts]'));
  await page.fill('#alert-symbol', 'infy');
  await page.selectOption('#alert-condition', 'below');
  await page.fill('#alert-price', '10');
  await page.getByRole('button', { name: 'Add alert' }).click();
  await expect(panel).toContainText('INFY');
  await expect(panel).toContainText('≤ ₹10');
  await page.getByRole('button', { name: 'Delete the INFY alert at ₹10' }).click();
  await expect(panel).toContainText('No active alerts.');

  await page.goto('/settings');
  await expect(page.locator('[data-notifications]')).toContainText('Notifications & app');
  await expect(page.locator('[data-notifications]')).toContainText('not configured on this server');
  await expect(page.locator('[data-telegram]')).toContainText(
    'Telegram is not configured on this server.',
  );
});

test('a mentor link opens a read-only journal without signing in', async ({ page, browser }) => {
  await signIn(page, MEMBERS.account);
  await apiRequest(page, 'POST', '/api/trades', {
    date: '2026-10-05',
    symbol: 'MENTOR',
    type: 'Long',
    entryPrice: 100,
    exitPrice: 104,
    quantity: 25,
    notes: 'not for the mentor',
  });
  await page.goto('/settings');
  await page.fill('#share-label', 'Weekly review');
  await page.getByRole('button', { name: 'Create link' }).click();
  const url = await page.locator('#share-created-url').inputValue();
  expect(url).toMatch(/\/share\/[A-Za-z0-9_-]{43}$/);

  const visitor = await browser.newContext();
  const mentor = await visitor.newPage();
  const errors = [];
  mentor.on('pageerror', (error) => errors.push(error.message));
  await mentor.goto(new URL(url).pathname);
  await expect(mentor.getByRole('heading', { name: 'Weekly review' })).toBeVisible();
  await expect(mentor.locator('[data-share]')).toContainText('MENTOR');
  await expect(mentor.locator('[data-share]')).not.toContainText('not for the mentor');
  expect(errors).toEqual([]);

  await page.getByRole('button', { name: 'Revoke Weekly review link' }).click();
  await expect(page.locator('[data-share-links]')).toContainText('revoked');
  await mentor.reload();
  await expect(mentor.getByRole('alert')).toContainText('invalid, expired or was revoked');
  await visitor.close();
});
