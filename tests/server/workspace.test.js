// @vitest-environment node
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMember, resetDatabase, signIn, startTestApp, stopTestApp } from '../helpers/app.js';
import { computeTradeEconomics } from '../../shared/pnl.js';
import { rMultiple } from '../../shared/trade-tags.js';
import { DEFAULT_CHARGES } from '../../shared/types.js';
import { User } from '../../models/index.js';

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetDatabase);

const TRADE = {
  date: '2026-10-05',
  symbol: 'infy',
  type: 'Long',
  entryPrice: 1500,
  exitPrice: 1520,
  quantity: 10,
  notes: 'breakout',
};

async function member(email = 'member@example.com') {
  const created = await createMember({ email });
  const session = await signIn(app, { email, password: created.password });
  const send = (method, path, body) =>
    session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body);
  return { ...session, send };
}

describe('trades', () => {
  it('computes economics on the server and ignores client-supplied totals', async () => {
    const { send } = await member();
    const created = await send('post', '/api/trades', { ...TRADE, pnl: 999999, charges: 0 });
    expect(created.status).toBe(201);
    const expected = computeTradeEconomics({ ...TRADE, symbol: 'INFY' }, DEFAULT_CHARGES);
    expect(created.body.trade).toMatchObject({
      symbol: 'INFY',
      grossPnl: expected.grossPnl,
      charges: expected.charges,
      pnl: expected.netPnl,
    });
  });

  it('rejects malformed prices instead of storing NaN', async () => {
    const { send } = await member();
    const response = await send('post', '/api/trades', { ...TRADE, entryPrice: 'abc' });
    expect(response.status).toBe(400);
  });

  it('recalculates on economic edits and preserves totals on note-only edits', async () => {
    const { send } = await member();
    const { trade } = (await send('post', '/api/trades', TRADE)).body;
    const notes = await send('put', `/api/trades/${trade.id}`, {
      ...TRADE,
      notes: 'updated',
      expectedOriginal: trade,
    });
    expect(notes.status).toBe(200);
    expect(notes.body.trade).toMatchObject({
      notes: 'updated',
      charges: trade.charges,
      pnl: trade.pnl,
    });
    const moved = await send('put', `/api/trades/${trade.id}`, {
      ...TRADE,
      exitPrice: 1530,
      expectedOriginal: notes.body.trade,
    });
    expect(moved.body.trade.grossPnl).toBe(300);
    const stale = await send('put', `/api/trades/${trade.id}`, {
      ...TRADE,
      notes: 'stale',
      expectedOriginal: trade,
    });
    expect(stale.status).toBe(409);
  });

  it('never exposes or changes another member’s trades', async () => {
    const owner = await member('owner@example.com');
    const other = await member('other@example.com');
    const { trade } = (await owner.send('post', '/api/trades', TRADE)).body;
    expect((await other.agent.get('/api/workspace')).body.trades).toEqual([]);
    expect((await other.send('delete', `/api/trades/${trade.id}`)).status).toBe(404);
    expect((await owner.agent.get('/api/workspace')).body.trades).toHaveLength(1);
  });

  it('imports idempotently by stable row ID', async () => {
    const { send, agent } = await member();
    const economics = computeTradeEconomics({ ...TRADE, symbol: 'INFY' }, DEFAULT_CHARGES);
    const row = {
      ...TRADE,
      symbol: 'INFY',
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      strategyId: null,
      grossPnl: economics.grossPnl,
      charges: economics.charges,
      pnl: economics.netPnl,
    };
    expect((await send('post', '/api/trades/import', { trade: row })).body.result).toBe('inserted');
    expect((await send('post', '/api/trades/import', { trade: row })).body.result).toBe(
      'already-present',
    );
    const tampered = await send('post', '/api/trades/import', {
      trade: { ...row, pnl: row.pnl + 1 },
    });
    expect(tampered.status).toBe(409);
    expect((await agent.get('/api/workspace')).body.trades).toHaveLength(1);

    // An option row from a CSV import (segment and option type from the contract name).
    const option = { ...TRADE, symbol: 'NIFTY26OCT24500CE', segment: 'OPT', optionType: 'CE' };
    const optionEconomics = computeTradeEconomics(option, DEFAULT_CHARGES);
    const imported = await send('post', '/api/trades/import', {
      trade: {
        ...option,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        strategyId: null,
        grossPnl: optionEconomics.grossPnl,
        charges: optionEconomics.charges,
        pnl: optionEconomics.netPnl,
      },
    });
    expect(imported.body).toMatchObject({ result: 'inserted' });
    const saved = (await agent.get('/api/workspace')).body.trades.find(
      (trade) => trade.symbol === 'NIFTY26OCT24500CE',
    );
    expect(saved).toMatchObject({ segment: 'OPT', optionType: 'CE' });
  });
});

describe('strategies, rules, watchlist, chat and settings', () => {
  it('unlinks trades when their strategy is deleted', async () => {
    const { send, agent } = await member();
    const { strategy } = (
      await send('post', '/api/strategies', {
        date: '2026-10-05',
        name: 'Gap fill',
        rules: 'Buy the half-gap fill by 10am.',
      })
    ).body;
    await send('post', '/api/trades', { ...TRADE, strategyId: strategy.id });
    expect((await send('delete', `/api/strategies/${strategy.id}`)).status).toBe(200);
    const { trades, strategies } = (await agent.get('/api/workspace')).body;
    expect(strategies).toEqual([]);
    expect(trades[0].strategyId).toBeNull();
  });

  it('stores rules, watchlist symbols, chat and settings per member', async () => {
    const { send, agent } = await member();
    expect(
      (
        await send('post', '/api/rules', {
          section: 'Risk',
          definition: 'Capital',
          rule: 'Max 1% per trade',
        })
      ).status,
    ).toBe(201);
    expect((await send('post', '/api/watchlist', { symbol: 'tcs' })).body.item.symbol).toBe('TCS');
    expect((await send('post', '/api/chat/messages', { role: 'user', text: 'hello' })).status).toBe(
      201,
    );
    const saved = await send('put', '/api/settings', {
      openingBalance: 250000,
      charges: { ...DEFAULT_CHARGES, enabled: false },
    });
    expect(saved.body.settings).toMatchObject({
      openingBalance: 250000,
      charges: { enabled: false },
    });
    const workspace = (await agent.get('/api/workspace')).body;
    expect(workspace.rules).toHaveLength(1);
    expect(workspace.watchlist.map((item) => item.symbol)).toEqual(['TCS']);
    expect(workspace.chatMessages).toHaveLength(1);
    expect(workspace.portfolioBalance).toBe(250000);
    expect((await send('delete', '/api/chat/messages')).status).toBe(200);
    expect((await agent.get('/api/workspace')).body.chatMessages).toEqual([]);
  });

  it('claims a username once and allows sign-in with it', async () => {
    const created = await createMember({ email: 'named@example.com' });
    const { agent, csrf } = await signIn(app, {
      email: 'named@example.com',
      password: created.password,
    });
    const claim = await agent
      .post('/api/username')
      .set('X-CSRF-Token', csrf)
      .send({ username: 'Trader_One' });
    expect(claim.body.username).toBe('trader_one');
    const again = await agent
      .post('/api/username')
      .set('X-CSRF-Token', csrf)
      .send({ username: 'another_name' });
    expect(again.status).toBeGreaterThanOrEqual(400);
    await signIn(app, { email: 'trader_one', password: created.password });
  });
});

describe('trade review fields', () => {
  it('stores cleaned tags, emotion and planned risk, and keeps them on metadata edits', async () => {
    const { send } = await member();
    const created = await send('post', '/api/trades', {
      ...TRADE,
      setupTags: ' Breakout ,breakout, Opening   range',
      mistakeTags: ['Moved stop', '', 'Moved stop'],
      emotion: 'fomo',
      plannedRisk: '250',
    });
    expect(created.status).toBe(201);
    const trade = created.body.trade;
    expect(trade).toMatchObject({
      setupTags: ['Breakout', 'Opening range'],
      mistakeTags: ['Moved stop'],
      emotion: 'fomo',
      plannedRisk: 250,
      hasScreenshot: false,
    });
    // An edit that omits the review fields (an older client) keeps them.
    const edited = await send('put', `/api/trades/${trade.id}`, {
      ...TRADE,
      notes: 'second look',
      expectedOriginal: trade,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.trade).toMatchObject({ setupTags: ['Breakout', 'Opening range'] });
    const cleared = await send('put', `/api/trades/${trade.id}`, {
      ...TRADE,
      mistakeTags: [],
      plannedRisk: null,
      expectedOriginal: edited.body.trade,
    });
    expect(cleared.body.trade).toMatchObject({ mistakeTags: [], plannedRisk: null });
  });

  it('rejects an unknown emotion or a negative planned risk', async () => {
    const { send } = await member();
    expect((await send('post', '/api/trades', { ...TRADE, emotion: 'euphoric' })).status).toBe(400);
    const risk = await send('post', '/api/trades', { ...TRADE, plannedRisk: -5 });
    expect(risk.status).toBe(400);
    expect(risk.body.fieldErrors).toHaveProperty('plannedRisk');
  });
});

describe('trade screenshots', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  it('attaches, serves only to the owner, replaces and removes a screenshot', async () => {
    const owner = await member();
    const { trade } = (await owner.send('post', '/api/trades', TRADE)).body;
    const upload = () =>
      owner.agent
        .post(`/api/trades/${trade.id}/screenshot`)
        .set('X-CSRF-Token', owner.csrf)
        .attach('file', PNG, { filename: 'chart.png', contentType: 'image/png' });
    const first = await upload();
    expect(first.status).toBe(201);
    expect(first.body.trade.hasScreenshot).toBe(true);
    const image = await owner.agent.get(`/api/trades/${trade.id}/screenshot`);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toMatch(/^image\/png/);

    const other = await member('other@example.com');
    expect((await other.agent.get(`/api/trades/${trade.id}/screenshot`)).status).toBe(404);

    expect((await upload()).status).toBe(201);
    const removed = await owner.send('delete', `/api/trades/${trade.id}/screenshot`);
    expect(removed.body.trade.hasScreenshot).toBe(false);
    expect((await owner.agent.get(`/api/trades/${trade.id}/screenshot`)).status).toBe(404);
  });

  it('refuses a screenshot beyond the 500 MB per member', async () => {
    const owner = await member();
    const { trade } = (await owner.send('post', '/api/trades', TRADE)).body;
    const { _id: userId } = await User.findOne({ email: 'member@example.com' }).lean();
    await mongoose.connection.db.collection('tradeScreenshots.files').insertOne({
      filename: `${userId}/old/file`,
      length: 500 * 1024 * 1024,
      uploadDate: new Date(),
    });
    const response = await owner.agent
      .post(`/api/trades/${trade.id}/screenshot`)
      .set('X-CSRF-Token', owner.csrf)
      .attach('file', PNG, { filename: 'chart.png', contentType: 'image/png' });
    expect(response.status).toBe(413);
    expect(response.body.error).toMatch(/500 MB/);
  });

  it('rejects files that are not images', async () => {
    const owner = await member();
    const { trade } = (await owner.send('post', '/api/trades', TRADE)).body;
    const response = await owner.agent
      .post(`/api/trades/${trade.id}/screenshot`)
      .set('X-CSRF-Token', owner.csrf)
      .attach('file', Buffer.from('%PDF-1.4'), {
        filename: 'x.pdf',
        contentType: 'application/pdf',
      });
    expect(response.status).toBe(415);
  });

  it('rejects a file whose contents are not the image type it claims', async () => {
    const owner = await member();
    const { trade } = (await owner.send('post', '/api/trades', TRADE)).body;
    const response = await owner.agent
      .post(`/api/trades/${trade.id}/screenshot`)
      .set('X-CSRF-Token', owner.csrf)
      .attach('file', Buffer.from('<script>alert(1)</script>'), {
        filename: 'chart.png',
        contentType: 'image/png',
      });
    expect(response.status).toBe(415);
    expect(response.body.error).toMatch(/contents do not match/);
  });
});

describe('F&O trades', () => {
  it('prices options with the options rates and keeps contract details', async () => {
    const { send } = await member();
    const created = await send('post', '/api/trades', {
      ...TRADE,
      symbol: 'NIFTY26OCT24500CE',
      entryPrice: 100,
      exitPrice: 120,
      quantity: 150,
      segment: 'OPT',
      lotSize: 75,
      expiry: '2026-10-27',
      strike: 24500,
      optionType: 'CE',
    });
    expect(created.status).toBe(201);
    expect(created.body.trade).toMatchObject({
      segment: 'OPT',
      lotSize: 75,
      expiry: '2026-10-27',
      strike: 24500,
      optionType: 'CE',
      grossPnl: 3000,
    });
    // ₹20 flat brokerage per order, not the equity 0.03% rate.
    const { computeCharges } = await import('../../shared/pnl.js');
    const { DEFAULT_FO_CHARGES } = await import('../../shared/segments.js');
    expect(created.body.trade.charges).toBe(
      computeCharges(
        { type: 'Long', entryPrice: 100, exitPrice: 120, quantity: 150 },
        DEFAULT_FO_CHARGES.options,
      ).total,
    );
  });

  it('rejects quantities that are not whole lots and saves custom F&O rates', async () => {
    const { send } = await member();
    const bad = await send('post', '/api/trades', {
      ...TRADE,
      segment: 'FUT',
      lotSize: 75,
      quantity: 100,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/lot size/);
    const { DEFAULT_FO_CHARGES } = await import('../../shared/segments.js');
    const saved = await send('put', '/api/settings', {
      foCharges: { futures: { ...DEFAULT_FO_CHARGES.futures, sttPercent: 0.05 } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.foCharges.futures.sttPercent).toBe(0.05);
    expect(saved.body.settings.foCharges.options).toEqual(DEFAULT_FO_CHARGES.options);
  });
});

describe('trade execution details', () => {
  it('averages partial exits, counts orders and keeps them on edits', async () => {
    const { send } = await member();
    const base = {
      date: '2026-10-05',
      symbol: 'SBIN',
      type: 'Long',
      entryPrice: '800',
      exitPrice: '0.01',
      quantity: '300',
      notes: '',
    };
    const created = await send('post', '/api/trades', {
      ...base,
      stopLoss: '790',
      entryTime: '09:20',
      exitTime: '14:45',
      entryOrders: '2',
      exitLegs: [
        { price: '810', quantity: '100' },
        { price: '820', quantity: '200' },
      ],
    });
    expect(created.status).toBe(201);
    const trade = created.body.trade;
    expect(trade).toMatchObject({
      exitPrice: 816.6667,
      stopLoss: 790,
      entryTime: '09:20',
      exitTime: '14:45',
      entryOrders: 2,
      exitOrders: 2,
      // Only an entered risk is stored; R comes from the stop until one is entered.
      plannedRisk: null,
      exitLegs: [
        { price: 810, quantity: 100 },
        { price: 820, quantity: 200 },
      ],
    });
    // ₹2,40,000 bought in 2 orders and ₹2,45,000 sold in 2: 0.03% stays under 2 × ₹20 caps.
    // Valued from the legs (₹2,45,000), not the rounded average exit price.
    expect(trade.grossPnl).toBe(5000);
    expect(rMultiple(trade)).toBe(Math.round((trade.pnl / 3000) * 100) / 100);

    const edited = await send('put', `/api/trades/${trade.id}`, {
      ...base,
      exitPrice: String(trade.exitPrice),
      notes: 'scaled out',
      expectedOriginal: trade,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.trade).toMatchObject({ notes: 'scaled out', exitOrders: 2, stopLoss: 790 });
    expect(edited.body.trade.charges).toBe(trade.charges);

    const bad = await send('post', '/api/trades', {
      ...base,
      exitPrice: '810',
      exitLegs: [
        { price: '810', quantity: '100' },
        { price: '820', quantity: '100' },
      ],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/add up to the trade quantity/);

    const single = await send('post', '/api/trades', {
      ...base,
      exitPrice: '810',
      exitLegs: [{ price: '810', quantity: '300' }],
    });
    expect(single.status).toBe(400);
    expect(single.body.error).toMatch(/at least two partial exits/);
  });
});

describe('strategy stages', () => {
  it('moves a strategy through stages and keeps the history', async () => {
    const { send } = await member();
    const { strategy } = (
      await send('post', '/api/strategies', { date: '2026-10-05', name: 'ORB', rules: 'x' })
    ).body;
    expect(strategy).toMatchObject({ stage: 'draft', stageHistory: [] });
    const paper = await send('put', `/api/strategies/${strategy.id}/stage`, {
      stage: 'paper',
      note: 'backtest looked fine',
    });
    expect(paper.body.strategy).toMatchObject({
      stage: 'paper',
      stageHistory: [{ stage: 'paper', note: 'backtest looked fine' }],
    });
    // Same stage again records nothing.
    const again = await send('put', `/api/strategies/${strategy.id}/stage`, { stage: 'paper' });
    expect(again.body.strategy.stageHistory).toHaveLength(1);
    // Editing the text keeps the stage.
    const edited = await send('put', `/api/strategies/${strategy.id}`, {
      date: '2026-10-05',
      name: 'ORB v2',
      rules: 'y',
    });
    expect(edited.body.strategy).toMatchObject({ name: 'ORB v2', stage: 'paper' });
    expect(
      (await send('put', `/api/strategies/${strategy.id}/stage`, { stage: 'won' })).status,
    ).toBe(400);
  });
});
