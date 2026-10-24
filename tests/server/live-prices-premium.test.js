// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The live chain (TrueData, then Zerodha) and the public delayed source answer with their name.
vi.mock('../../services/market/index.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    getQuote: async (symbol) => ({ symbol, source: 'live' }),
    getHistory: async (symbol) => ({ symbol, candles: [], source: 'live' }),
    yahooProvider: {
      ...actual.yahooProvider,
      fetchQuote: async (symbol) => ({ symbol, source: 'yahoo' }),
      fetchHistory: async (symbol) => ({ symbol, candles: [], source: 'yahoo' }),
    },
  };
});

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const { PlatformSetting, Subscription } = await import('../../models/index.js');
const { forgetPlanCache } = await import('../../services/billing/plan.js');

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(async () => {
  await resetDatabase();
  forgetPlanCache();
});

async function billing(plan) {
  await PlatformSetting.create({ _id: 'billing.plan', value: { enabled: true, ...plan } });
  forgetPlanCache();
}

async function member() {
  const { user, password } = await createMember();
  const { agent } = await signIn(app, { email: user.email, password });
  const sources = async () => [
    (await agent.get('/api/quote?symbol=INFY')).body.source,
    (await agent.get('/api/history?symbol=INFY&from=2026-01-05&to=2026-01-09')).body.source,
  ];
  return { user, agent, sources };
}

describe('live prices behind Premium', () => {
  it('gives live prices to everyone while billing is off', async () => {
    const { sources } = await member();
    expect(await sources()).toEqual(['live', 'live']);
  });

  it('serves a free member delayed prices and the upgrade page for the live chart', async () => {
    await billing({ trialDays: 0, features: ['livePrices'] });
    const { user, agent, sources } = await member();
    expect(await sources()).toEqual(['yahoo', 'yahoo']);
    const chart = await agent.get('/chart');
    expect(chart.status).toBe(402);
    expect(chart.text).toContain('/billing');

    await Subscription.updateOne(
      { _id: user._id },
      { $set: { grantUntil: new Date(Date.now() + 86_400_000) } },
      { upsert: true },
    );
    expect(await sources()).toEqual(['live', 'live']);
    expect((await agent.get('/chart')).status).toBe(200);
  });

  it('does not start a trial from a price lookup', async () => {
    await billing({ trialDays: 14, features: ['livePrices'] });
    const { user, sources } = await member();
    // A member about to start a trial counts as on it.
    expect(await sources()).toEqual(['live', 'live']);
    expect(await Subscription.exists({ _id: user._id })).toBeNull();
  });
});
