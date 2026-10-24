import { expect, test } from '@playwright/test';
import { MEMBERS, apiRequest, signIn, trackErrors, unique } from './helpers.js';

test('log, edit, filter and delete a trade', async ({ page }) => {
  const errors = trackErrors(page);
  const symbol = `E2E${unique().toUpperCase()}`.slice(0, 10);
  await signIn(page, MEMBERS.journal);

  await page.goto('/journal');
  await page.fill('#trade-symbol', symbol);
  await page.fill('#trade-qty', '10');
  await page.fill('#trade-entry', '100');
  await page.fill('#trade-exit', '110');
  await page.getByText('Review (optional)').click();
  await page.fill('#trade-setup', 'Breakout');
  await page.getByRole('button', { name: 'Moved stop' }).click();
  await page.selectOption('#trade-emotion', 'fomo');
  await page.fill('#trade-risk', '50');
  await page.click('[data-trade-form] button[type=submit]');
  await page
    .getByRole('dialog', { name: 'Confirm trade' })
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect(page.locator('[data-recent-trades]')).toContainText(symbol);

  await page.goto('/transactions');
  await page.fill('#tx-search', symbol);
  await expect(page.locator('[data-ledger]')).toContainText(symbol);
  await expect(page.locator('[data-ledger]')).toContainText('Moved stop');
  await expect(page.locator('[data-ledger]')).toContainText('Breakout');
  await page.getByRole('button', { name: `Edit ${symbol} trade` }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit trade' });
  await dialog.locator('input[placeholder="155.00"]').fill('120');
  await dialog.locator('button[type=submit]').click();
  await page
    .getByRole('dialog', { name: 'Confirm trade' })
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect(page.locator('[data-ledger]')).toContainText('120');

  await page.getByRole('button', { name: `Delete ${symbol} trade` }).click();
  await page
    .getByRole('dialog', { name: 'Delete trade' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.locator('[data-ledger]')).not.toContainText(symbol);
  expect(errors).toEqual([]);
});

test('a trade with a stop, times and partial exits', async ({ page }) => {
  const errors = trackErrors(page);
  const symbol = `PX${unique().toUpperCase()}`.slice(0, 10);
  await signIn(page, MEMBERS.journal);
  await page.goto('/journal');
  await page.fill('#trade-symbol', symbol);
  await page.fill('#trade-qty', '30');
  await page.fill('#trade-entry', '100');
  await page.getByText('Execution (optional)').click();
  await page.fill('#trade-stop', '97.5');
  await page.fill('#trade-entry-time', '09:20');
  await page.fill('#trade-exit-time', '14:45');
  await page.getByRole('button', { name: 'Split the exit into parts' }).click();
  await page.fill('#trade-leg-price-0', '110');
  await page.fill('#trade-leg-qty-0', '10');
  await page.fill('#trade-leg-price-1', '120');
  await page.fill('#trade-leg-qty-1', '20');
  // The exit price is the weighted average and cannot be typed over.
  await expect(page.locator('#trade-exit')).toHaveValue('116.6667');
  await expect(page.locator('#trade-exit')).toHaveJSProperty('readOnly', true);
  await page.click('[data-trade-form] button[type=submit]');
  const confirm = page.getByRole('dialog', { name: 'Confirm trade' });
  await expect(confirm).toContainText('₹75.00');
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('[data-recent-trades]')).toContainText(symbol);
  await page.goto('/transactions');
  await page.fill('#tx-search', symbol);
  const ledger = page.locator('[data-ledger]');
  await expect(ledger).toContainText('09:20–14:45');
  await expect(ledger).toContainText('SL 97.5');
  await expect(ledger).toContainText('2 exits');
  // Replay opens the trade day's chart (or says why it cannot, offline).
  await page.getByRole('button', { name: `Replay ${symbol} trade on the chart` }).click();
  const replay = page.getByRole('dialog', { name: `${symbol} replay` });
  await expect(replay).toContainText(/Dashed lines: entry, exit and stop-loss|not available/);
  await page.keyboard.press('Escape');
  await expect(replay).toBeHidden();
  // Leave today's P&L as other tests expect it.
  await page.getByRole('button', { name: `Delete ${symbol} trade` }).click();
  await page
    .getByRole('dialog', { name: 'Delete trade' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(ledger).not.toContainText(symbol);
  expect(errors).toEqual([]);
});

test('import trades from CSV and detect duplicates', async ({ page }) => {
  const symbol = `CSV${unique().toUpperCase()}`.slice(0, 10);
  const csv = `Date,Symbol,Type,Entry,Exit,Qty\n05/10/2026,${symbol},BUY,100,105,10\n06/10/2026,${symbol},SELL,200,190,5\n`;
  await signIn(page, MEMBERS.journal);
  await page.goto('/import');
  await page.setInputFiles('[data-file-input]', {
    name: 'trades.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  // The page reloads itself after an import so duplicate detection sees the new rows.
  const reloaded = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Import 2 trades' }).click();
  await reloaded;
  await page.setInputFiles('[data-file-input]', {
    name: 'trades.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await expect(page.locator('[data-import-root]')).toContainText('Duplicates2');
});

test('a broker tradebook is paired into round trips before import', async ({ page }) => {
  const symbol = `TB${unique().toUpperCase()}`.slice(0, 10);
  const csv = [
    'symbol,trade_date,exchange,segment,trade_type,quantity,price,trade_id,order_execution_time',
    `${symbol},2026-05-04,NSE,EQ,buy,10,100,1,2026-05-04T09:20:00`,
    `${symbol},2026-05-04,NSE,EQ,buy,10,102,2,2026-05-04T09:40:00`,
    `${symbol},2026-05-04,NSE,EQ,sell,20,105,3,2026-05-04T14:10:00`,
    `${symbol},2026-05-05,NSE,EQ,buy,5,110,4,2026-05-05T10:00:00`,
    `NIFTY26MAYFUT,2026-05-05,NFO,FO,buy,75,24000,5,2026-05-05T10:00:00`,
  ].join('\n');
  await signIn(page, MEMBERS.journal);
  await page.goto('/import');
  await page.setInputFiles('[data-file-input]', {
    name: 'tradebook.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  const notice = page.locator('[data-tradebook]');
  await expect(notice).toContainText(
    'Read 4 equity fills and paired them into 1 same-day round trip',
  );
  await expect(notice).toContainText(`${symbol} +5 on 2026-05-05`);
  await expect(notice).toContainText('1 row was skipped');
  const reloaded = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Import 1 trade' }).click();
  await reloaded;
  const workspace = await apiRequest(page, 'GET', '/api/account/export');
  const trade = workspace.body.trades.find((row) => row.symbol === symbol);
  expect(trade).toMatchObject({ type: 'Long', entryPrice: 101, exitPrice: 105, quantity: 20 });
});

test('rules and strategy drafts are saved', async ({ page }) => {
  const name = `Rule ${unique()}`;
  await signIn(page, MEMBERS.journal);
  await page.goto('/rules');
  await page.click('[data-add-rule]');
  await page.fill('#r-section', name);
  await page.fill('#r-definition', 'Capital protection');
  await page.fill('#r-rule', 'Never risk more than 1% per trade.');
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.locator('[data-rules]')).toContainText(name);

  const strategy = `Strategy ${unique()}`;
  await page.goto('/strategy');
  // The draft picker only exists once the account has a strategy.
  if (await page.locator('#written-strategy-source').count()) {
    await page.selectOption('#written-strategy-source', '');
  }
  await page.fill('#written-strategy-name', strategy);
  await page.fill('#written-strategy-conditions', 'Buy the half-gap fill by 10am.');
  await page.getByRole('button', { name: 'Save strategy draft' }).click();
  await page.reload();
  await page.click('[data-library-summary]');
  await expect(page.locator('[data-library]')).toContainText(strategy);
  const strategyCard = page.locator('[data-library] .group').filter({ hasText: strategy });
  await strategyCard.getByLabel('Stage').selectOption('paper');
  await expect(strategyCard).toContainText('Tried at live prices without real orders.');
  await expect(strategyCard).toContainText('since');
});

test('the ledger shows 200 trades at a time with totals for all of them', async ({ page }) => {
  const symbol = `PG${unique().toUpperCase()}`.slice(0, 10);
  await signIn(page, MEMBERS.journal);
  await page.goto('/transactions');
  for (let index = 0; index < 205; index += 1) {
    const result = await apiRequest(page, 'POST', '/api/trades', {
      date: '2026-10-05',
      symbol,
      type: 'Long',
      entryPrice: 100,
      exitPrice: 101,
      quantity: 1,
    });
    expect(result.status).toBe(201);
  }
  await page.reload();
  await page.fill('#tx-search', symbol);
  await expect(page.locator('[data-summary]')).toContainText('205 of');
  await expect(page.locator('[data-ledger]')).toContainText('Showing 200 of 205 matching trades.');
  await expect(page.locator('[data-ledger] tbody tr')).toHaveCount(200);
  await page.getByRole('button', { name: 'Show 5 more' }).click();
  await expect(page.locator('[data-ledger] tbody tr')).toHaveCount(205);
  await expect(page.locator('[data-ledger]')).not.toContainText('matching trades.');
});

test('insights show the calendar, mistake cost and R-multiples', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page, MEMBERS.journal);
  await page.goto('/insights');
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()),
  );
  // A recent weekday so the trade falls inside the calendar's three months.
  const date = await page.evaluate((iso) => {
    const day = new Date(`${iso}T00:00:00Z`);
    while ([0, 6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() - 1);
    return day.toISOString().slice(0, 10);
  }, today);
  const tag = `Late entry ${unique()}`;
  const result = await apiRequest(page, 'POST', '/api/trades', {
    date,
    symbol: 'INSIGHT',
    type: 'Long',
    entryPrice: 100,
    exitPrice: 95,
    quantity: 10,
    mistakeTags: [tag],
    plannedRisk: 25,
  });
  expect(result.status).toBe(201);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mistakes' })).toBeVisible();
  // No OpenAI key in the test server: the coach card explains instead of offering buttons.
  await expect(page.locator('[data-coach]')).toContainText(
    'The AI coach is temporarily unavailable',
  );
  await expect(page.locator('[data-insights]')).toContainText(tag);
  await expect(page.locator('[data-insights]')).toContainText('Average R');
  await expect(page.getByRole('img', { name: new RegExp(`^${date}: -`) })).toBeVisible();
  expect(errors).toEqual([]);
});

test('today’s Zerodha fills can be added from the trade book', async ({ page }) => {
  const errors = trackErrors(page);
  const symbol = `ZF${unique().toUpperCase()}`.slice(0, 10);
  const trip = {
    id: '11111111-2222-8333-8444-555555555555',
    date: '2026-10-05',
    symbol,
    type: 'Long',
    entryPrice: 100,
    exitPrice: 105,
    quantity: 10,
    exchange: 'NSE',
    product: 'MIS',
    fills: 2,
    grossPnl: 50,
    charges: 1.2,
    pnl: 48.8,
    alreadyInJournal: false,
    problem: null,
  };
  let imported = null;
  await page.route('**/api/kite/fills', (route) =>
    route.fulfill({
      json: {
        tradingDate: '2026-10-05',
        fetchedAt: new Date().toISOString(),
        candidates: [trip],
        open: [{ symbol: 'TCS', exchange: 'NSE', product: 'MIS', quantity: 5 }],
        skipped: [],
      },
    }),
  );
  await page.route('**/api/kite/fills/import', (route) => {
    imported = route.request().postDataJSON();
    route.fulfill({
      json: {
        added: [
          {
            ...trip,
            notes: 'Added from Zerodha fills',
            strategyId: null,
            setupTags: [],
            mistakeTags: [],
            emotion: '',
            plannedRisk: null,
            hasScreenshot: false,
            createdAt: new Date().toISOString(),
          },
        ],
        skipped: 0,
      },
    });
  });
  await signIn(page, MEMBERS.journal);
  await page.goto('/transactions');
  await page.getByRole('button', { name: 'Add today’s fills to journal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add today’s fills to journal' });
  await expect(dialog).toContainText(symbol);
  await expect(dialog).toContainText('Still open, not added: TCS (+5)');
  await dialog.getByRole('button', { name: 'Add 1 trade to journal' }).click();
  await expect(dialog).toBeHidden();
  expect(imported).toEqual({ ids: [trip.id] });
  await expect(page.locator('[data-ledger]')).toContainText(symbol);
  expect(errors).toEqual([]);
});

test('an options trade records its contract and uses options charges', async ({ page }) => {
  const errors = trackErrors(page);
  const symbol = `NIFTY${unique().toUpperCase()}CE`.slice(0, 20);
  await signIn(page, MEMBERS.journal);
  await page.goto('/journal');
  await page.fill('#trade-symbol', symbol);
  await page.selectOption('#trade-segment', 'OPT');
  await page.fill('#trade-lot', '75');
  await page.fill('#trade-qty', '100');
  await page.fill('#trade-entry', '100');
  await page.fill('#trade-exit', '120');
  await page.fill('#trade-expiry', '2026-10-27');
  await page.fill('#trade-strike', '24500');
  await page.click('[data-trade-form] button[type=submit]');
  await expect(page.locator('[data-trade-form]')).toContainText('multiple of the lot size');
  await page.fill('#trade-qty', '150');
  await page.click('[data-trade-form] button[type=submit]');
  const confirm = page.getByRole('dialog', { name: 'Confirm trade' });
  await expect(confirm).toContainText('CE 24500 · exp 2026-10-27 · lot 75');
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.goto('/transactions');
  await page.fill('#tx-search', symbol);
  await expect(page.locator('[data-ledger]')).toContainText('CE 24500 · exp 2026-10-27 · 2 × 75');
  expect(errors).toEqual([]);
});

test('on a phone the trade book shows each trade as a labelled card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, MEMBERS.journal);
  await page.goto('/transactions');
  const cell = page.locator('[data-ledger] td[data-label="Net P&L"]').first();
  await expect(cell).toBeVisible();
  // The heading row is visually hidden; the label is printed beside the value.
  await expect(page.locator('[data-ledger] thead')).toHaveCSS('position', 'absolute');
  const table = page.locator('[data-ledger] table');
  const box = await table.boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
  // Filters now include segment and strategy.
  await page.selectOption('#tx-segment', 'OPT');
  await page.selectOption('#tx-segment', 'all');
});
