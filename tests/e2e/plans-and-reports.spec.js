import { expect, test } from '@playwright/test';
import { MEMBERS, apiRequest, signIn } from './helpers.js';

test('calculator plan appears in order review and the planning report', async ({ page }) => {
  await signIn(page, MEMBERS.plans);
  await page.goto('/calculator');
  await page.getByText('Enter an instrument manually').click();
  await page.fill('#calc-symbol', 'RELIANCE');
  await page.fill('#calc-accountSize', '100000');
  await page.fill('#calc-entryPrice', '1400');
  await page.fill('#calc-riskPercent', '1');
  await expect(page.locator('#calc-estimatedRoundTripCharges')).toHaveAttribute(
    'placeholder',
    'From Settings',
  );
  await page.getByRole('button', { name: /Add to order review/ }).click();
  await page.waitForURL('**/orders');
  await expect(page.locator('[data-plans]')).toContainText('RELIANCE · BUY · MIS');
  await expect(page.locator('[data-sync-status]')).toContainText('synced', { timeout: 20_000 });
  await page.goto('/reports');
  await expect(page.locator('.rr-table tbody')).toContainText('RELIANCE');
});

test('journal report generates and downloads a PDF', async ({ page }) => {
  await signIn(page, MEMBERS.plans);
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  await apiRequest(page, 'POST', '/api/trades', {
    date: today,
    symbol: 'INFY',
    type: 'Long',
    entryPrice: 1500,
    exitPrice: 1520,
    quantity: 10,
  });
  await page.goto('/reports');
  await page.click('[data-source=journal]');
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(
    page.locator('.printable-report').filter({ hasText: 'Trading Performance Report' }),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  expect((await download).suggestedFilename()).toMatch(/^Trading_Report_.*\.pdf$/);
});

test('tax report summarises the financial year and downloads a CSV', async ({ page }) => {
  await signIn(page, MEMBERS.plans);
  await page.goto('/tax');
  const result = await apiRequest(page, 'POST', '/api/trades', {
    date: '2026-05-04',
    symbol: 'TAXCHECK',
    type: 'Long',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 10,
  });
  expect(result.status).toBe(201);
  await page.reload();
  await page.selectOption('[data-year]', '2026-27');
  await expect(page.locator('[data-tax]')).toContainText('Summary · FY 2026-27');
  await expect(page.locator('[data-tax]')).toContainText('Advance tax checkpoints');
  const download = page.waitForEvent('download');
  await page.click('[data-tax-csv]');
  const file = await download;
  expect(file.suggestedFilename()).toBe('tax-report-FY2026-27.csv');
  const text = await (await import('node:fs/promises')).readFile(await file.path(), 'utf8');
  expect(text).toContain('TAXCHECK');
});

test('paper trading starts a trade and shows open and closed results', async ({ page }) => {
  const now = new Date().toISOString();
  const open = {
    id: 'p1',
    symbol: 'INFY',
    direction: 'Long',
    quantity: 10,
    entryPrice: 1500,
    stopLoss: 1480,
    takeProfit: 1550,
    status: 'open',
    lastPrice: 1510,
    openPnl: 100,
    openedAt: now,
  };
  const closed = {
    ...open,
    id: 'p0',
    status: 'closed',
    exitPrice: 1550,
    exitReason: 'target',
    grossPnl: 500,
    charges: 12.5,
    pnl: 487.5,
    closedAt: now,
  };
  let started = null;
  let trades = { open: [], closed: [closed] };
  await page.route('**/api/paper/refresh', (route) =>
    route.fulfill({
      json: {
        ...trades,
        closedNow: 0,
        summary: { totalTrades: 1, netPnl: 487.5, winRate: 100, profitFactor: null },
      },
    }),
  );
  await page.route('**/api/paper', (route) => {
    started = route.request().postDataJSON();
    trades = { ...trades, open: [open] };
    route.fulfill({ status: 201, json: { trade: open } });
  });
  await signIn(page, MEMBERS.plans);
  await page.goto('/paper');
  await expect(page.locator('[data-paper-trades]')).toContainText('Target hit');
  await page.fill('#paper-symbol', 'INFY');
  await page.fill('#paper-qty', '10');
  await page.fill('#paper-stop', '1480');
  await page.fill('#paper-target', '1550');
  await page.getByRole('button', { name: 'Start paper trade' }).click();
  await expect(page.locator('[data-paper-trades]')).toContainText('Open (1)');
  expect(started).toMatchObject({ symbol: 'INFY', direction: 'Long', quantity: '10' });
  await expect(page.getByRole('button', { name: 'Close the INFY paper trade' })).toBeVisible();
});

test('a filled CNC live order offers a stop & target GTT', async ({ page }) => {
  await signIn(page, MEMBERS.plans);
  await page.goto('/orders');
  await expect(page.locator('[data-plans]')).toContainText('RELIANCE');
  const planId = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) => /:plan:/.test(name));
    return key.split(':plan:')[1];
  });
  const order = {
    id: 'live-1',
    planId,
    status: 'placed',
    symbol: 'RELIANCE',
    side: 'BUY',
    product: 'CNC',
    quantity: 7,
    price: '1400',
    brokerOrderId: '250101000000001',
    createdAt: new Date().toISOString(),
    gtt: null,
  };
  let gttRequest = null;
  const state = {
    enabled: true,
    accountEnabled: true,
    mfaVerified: true,
    marketOpen: true,
    usedToday: 1,
    dailyLimit: 5,
  };
  await page.route('**/api/live-orders', (route) =>
    route.fulfill({ json: { state, orders: [order] } }),
  );
  await page.route('**/api/live-orders/live-1/gtt', (route) => {
    gttRequest = route.request().postDataJSON();
    order.gtt = { status: 'placed', triggerId: '987', stop: 1386, target: 1430, error: null };
    route.fulfill({ json: { order } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Place stop & target (GTT)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Place stop & target on Zerodha' });
  await expect(dialog.getByRole('button', { name: 'Place GTT' })).toBeDisabled();
  await dialog.locator('#gtt-confirm-symbol').fill('reliance');
  await dialog.getByRole('button', { name: 'Place GTT' }).click();
  await expect(dialog).toBeHidden();
  expect(gttRequest).toEqual({ confirmSymbol: 'reliance' });
  await expect(page.locator('[data-plans]')).toContainText('Stop & target GTT placed');
  await expect(page.locator('[data-plans]')).toContainText('GTT 987');
});
