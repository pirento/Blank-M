// @vitest-environment node
// The pre-trade plan check: facts from the member's own journal and limits, an AI review that can
// never soften a limit, and the facts still answered when AI is off.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ai = vi.hoisted(() => ({ calls: [], verdict: 'fits' }));
vi.mock('../../services/ai/openai.js', async (original) => ({
  ...(await original()),
  structured: async (options) => {
    ai.calls.push(options);
    return {
      data: {
        verdict: ai.verdict,
        summary: 'The plan follows your rules.',
        ruleConflicts: [],
        questions: ['Is the stop below the day low?'],
      },
      sources: [],
    };
  },
}));

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const { OrderPlanRecord } = await import('../../models/index.js');
const { createTrade, saveAccountSettings } = await import('../../services/journal/workspace.js');
const { calculateRiskPlan } = await import('../../shared/risk-calculator.js');
const { DEFAULT_CHARGES } = await import('../../shared/types.js');
const { todayInIst } = await import('../../shared/market.js');

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  delete process.env.OPENAI_API_KEY;
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  process.env.OPENAI_API_KEY = 'sk-test';
  ai.calls = [];
  ai.verdict = 'fits';
});

let revision = 0;

/** A synced plan record: buy RELIANCE at 100, stop 95, target 110, 1% of ₹1,00,000. */
async function savedPlan(userId) {
  const id = randomUUID();
  const inputs = {
    direction: 'Long',
    accountSize: '100000',
    riskPercent: '1',
    entryPrice: '100',
    stopLoss: '95',
    takeProfit: '110',
    product: 'MIS',
  };
  await OrderPlanRecord.create({
    userId,
    recordKey: `plan:${id}`,
    recordKind: 'plan',
    serverRevision: ++revision,
    record: {
      id,
      symbol: 'RELIANCE',
      direction: 'Long',
      product: 'MIS',
      inputs,
      estimate: calculateRiskPlan(inputs, DEFAULT_CHARGES).plan,
      strategySnapshot: null,
      rulesSnapshot: [{ id: 'r1', section: 'Risk', rule: 'Never risk more than 1% on a trade.' }],
    },
  });
  return id;
}

const check = (session, planId) =>
  session.agent.post('/api/ai/plan-check').set('X-CSRF-Token', session.csrf).send({ planId });

describe('plan check', () => {
  it('answers facts and the AI review, with the rules and record in the AI input', async () => {
    const { user, password } = await createMember();
    const session = await signIn(app, { email: user.email, password });
    const planId = await savedPlan(user._id);
    const response = await check(session, planId);
    expect(response.status).toBe(200);
    expect(response.body.warnings).toEqual([]);
    expect(response.body.review).toMatchObject({
      verdict: 'fits',
      questions: ['Is the stop below the day low?'],
    });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].input).toContain('Never risk more than 1% on a trade.');
    expect(ai.calls[0].input).toContain('Journal, RELIANCE: no trades yet');
  });

  it('never lets the AI soften a reached limit', async () => {
    const { user, password } = await createMember();
    const session = await signIn(app, { email: user.email, password });
    await saveAccountSettings(user._id, { riskLimits: { dailyLossLimit: 500 } });
    await createTrade(user._id, {
      date: todayInIst(),
      symbol: 'INFY',
      type: 'Long',
      entryPrice: '100',
      exitPrice: '90',
      quantity: '100',
    });
    const response = await check(session, await savedPlan(user._id));
    expect(response.status).toBe(200);
    expect(response.body.warnings[0]).toMatchObject({ level: 'stop' });
    expect(response.body.review.verdict).toBe('skip');
  });

  it('still answers the facts without an AI key, and only for the member’s own synced plan', async () => {
    const { user, password } = await createMember();
    const session = await signIn(app, { email: user.email, password });
    const planId = await savedPlan(user._id);
    delete process.env.OPENAI_API_KEY;
    const response = await check(session, planId);
    expect(response.status).toBe(200);
    expect(response.body.review).toBeNull();
    expect(response.body.reviewUnavailable).toMatch(/not set up/);
    expect(response.body.facts.plannedLoss).toBeGreaterThan(0);
    expect(ai.calls).toHaveLength(0);

    const other = await createMember({ email: 'other@example.com' });
    const otherPlan = await savedPlan(other.user._id);
    expect((await check(session, otherPlan)).status).toBe(409);
    expect((await check(session, '')).status).toBe(400);
  });
});
