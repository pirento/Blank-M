import { expect, test } from '@playwright/test';
import { MEMBERS, signIn, trackErrors } from './helpers.js';

// Settings cards with their own member, so account.spec.js stays under the
// per-account sign-in limit (10 per 15 minutes).

test('the interface can be switched to Hindi and back', async ({ page }) => {
  await signIn(page, MEMBERS.settings);
  await page.goto('/settings');
  await page.selectOption('#language-select', 'hi');
  await page.waitForLoadState('load');
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('सेटिंग्स');
  await expect(page.getByRole('navigation', { name: 'मुख्य' })).toContainText('ओवरव्यू');
  // Cards rendered in the browser use the same catalog.
  await expect(page.locator('[data-risk-limits]')).toContainText('रिस्क सीमाएँ');
  await page.goto('/dashboard');
  await expect(page.locator('.reference-account-ledger')).toContainText('प्लानिंग पूँजी');
  await page.goto('/settings');
  await page.selectOption('#language-select', 'en');
  await page.waitForLoadState('load');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
});

test('Dhan connects with a token and its fills can be added', async ({ page }) => {
  let status = { connected: false, expired: false, clientId: null, expiresAt: null };
  let sentToken = null;
  await page.route('**/api/dhan', (route) => route.fulfill({ json: status }));
  await page.route('**/api/dhan/connect', (route) => {
    sentToken = route.request().postDataJSON().accessToken;
    status = {
      connected: true,
      expired: false,
      clientId: '1100000001',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    route.fulfill({ json: status });
  });
  await page.route('**/api/dhan/fills', (route) =>
    route.fulfill({
      json: {
        tradingDate: '2026-10-12',
        candidates: [
          {
            id: 'trip-1',
            date: '2026-10-12',
            symbol: 'TCS',
            type: 'Long',
            quantity: 4,
            entryPrice: 3400,
            exitPrice: 3410,
            exchange: 'NSE',
            product: 'INTRADAY',
            fills: 2,
            grossPnl: 40,
            charges: 10,
            pnl: 30,
            alreadyInJournal: false,
            problem: null,
          },
        ],
        open: [],
        skipped: [],
      },
    }),
  );
  await signIn(page, MEMBERS.settings);
  await page.goto('/settings');
  const card = page.locator('[data-dhan]');
  await expect(card).toContainText('Not connected.');
  await card.locator('#dhan-token').fill('header.payload.signature-token');
  await card.getByRole('button', { name: 'Connect Dhan' }).click();
  await expect(card).toContainText('Connected to Dhan client 1100000001');
  expect(sentToken).toBe('header.payload.signature-token');
  await card.getByRole('button', { name: 'Add today’s Dhan fills to journal' }).click();
  await expect(page.getByRole('dialog')).toContainText('TCS');
});

test('risk limits are saved and shown on the overview', async ({ page }) => {
  await signIn(page, MEMBERS.settings);
  await page.goto('/settings');
  await page.fill('#risk-daily-loss', '2500');
  await page.fill('#risk-max-trades', '4');
  await page.fill('#risk-month-goal', '');
  await page.getByRole('button', { name: 'Save risk limits' }).click();
  await expect(page.locator('[data-risk-limits]')).toContainText('Risk limits saved.');
  await page.goto('/dashboard');
  const strip = page.getByRole('region', { name: 'Risk limits today' });
  await expect(strip).toContainText('loss limit');
  await expect(strip).toContainText('Trades today');
  await page.goto('/settings');
  await expect(page.locator('#risk-max-trades')).toHaveValue('4');
  // Turn them off again so other tests see a clean overview.
  for (const id of ['#risk-daily-loss', '#risk-max-trades']) await page.fill(id, '');
  await page.getByRole('button', { name: 'Save risk limits' }).click();
  await expect(page.locator('[data-risk-limits]')).toContainText('Risk limits saved.');
});

test('the daily automatic journal can be turned on and off', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page, MEMBERS.settings);
  await page.goto('/settings');
  const card = page.locator('[data-daily-journal]');
  const toggle = card.getByLabel('Add today’s broker fills to my journal after the close');
  await toggle.check();
  await expect(card).toContainText('Today’s fills will be added after the close.');
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(card).toContainText('The daily automatic journal is off.');
  expect(errors).toEqual([]);
});
