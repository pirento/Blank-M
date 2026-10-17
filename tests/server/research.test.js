// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMember, resetDatabase, signIn, startTestApp, stopTestApp } from '../helpers/app.js';
import { exportOrderPlanRecords, saveOrderPlan } from '../../shared/order-plans.js';
import { calculateRiskPlan } from '../../shared/risk-calculator.js';
import { DEFAULT_CHARGES } from '../../shared/types.js';
import { evidencePayload } from '../fixtures/strategy-evidence.js';

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(async () => {
  await resetDatabase();
  // The plan store is browser code; give it an isolated in-memory storage.
  const store = new Map();
  globalThis.window = {
    localStorage: {
      get length() {
        return store.size;
      },
      key: (index) => [...store.keys()][index] ?? null,
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    dispatchEvent: () => true,
  };
});

async function member(email = 'member@example.com') {
  const created = await createMember({ email });
  const session = await signIn(app, { email, password: created.password });
  return {
    ...session,
    userId: created.user._id,
    send: (method, path, body) =>
      session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body),
  };
}

function plan() {
  const inputs = {
    direction: 'Long',
    accountSize: '100000',
    availableCapital: '20000',
    riskPercent: '1',
    entryPrice: '100',
    stopLoss: '95',
    takeProfit: '110',
    product: 'MIS',
    marginPercent: '100',
  };
  const chargesSnapshot = { ...DEFAULT_CHARGES };
  const result = calculateRiskPlan(inputs, chargesSnapshot);
  return {
    symbol: 'RELIANCE',
    direction: 'Long',
    product: 'MIS',
    inputs,
    estimate: result.plan,
    chargesSnapshot,
    strategySnapshot: null,
    rulesSnapshot: [],
    quoteSnapshot: null,
  };
}

describe('order plan records', () => {
  it('appends validated frozen plans once and pages them by revision', async () => {
    const { send, agent, userId } = await member();
    saveOrderPlan(userId, plan());
    const [record] = exportOrderPlanRecords(userId);
    const first = await send('post', '/api/order-plans', record);
    expect(first.status).toBeLessThan(300);
    const again = await send('post', '/api/order-plans', record);
    expect(again.body).toMatchObject({ inserted: false, matches: true });
    const page = await agent.get('/api/order-plans');
    expect(page.body.count).toBe(1);
    expect(page.body.rows[0]).toMatchObject({ user_id: userId, record_key: record.record_key });
  });

  it('rejects tampered economics and another owner’s record', async () => {
    const { send, userId } = await member();
    saveOrderPlan(userId, plan());
    const [record] = exportOrderPlanRecords(userId);
    const tampered = structuredClone(record);
    tampered.record.estimate.quantity += 1;
    expect((await send('post', '/api/order-plans', tampered)).status).toBe(400);
    expect(
      (await send('post', '/api/order-plans', { ...record, user_id: randomUUID() })).status,
    ).toBe(403);
  });
});

describe('strategy evidence', () => {
  it('saves recomputed evidence for the current draft and appends owner reviews', async () => {
    const { send, agent } = await member();
    const { strategy } = (
      await send('post', '/api/strategies', {
        date: '2026-10-09',
        name: 'Crossover draft',
        rules: 'Research moving average crossover entries.',
      })
    ).body;
    const id = randomUUID();
    const saved = await send('post', '/api/strategy-evidence', {
      id,
      snapshot: strategy,
      evidence: evidencePayload(),
    });
    expect(saved.status).toBe(201);
    expect(saved.body.record).toMatchObject({ id, strategy_id: strategy.id, latest_review: null });

    const tampered = evidencePayload();
    tampered.result.metrics.netProfit += 1;
    expect(
      (
        await send('post', '/api/strategy-evidence', {
          id: randomUUID(),
          snapshot: strategy,
          evidence: tampered,
        })
      ).status,
    ).toBe(400);

    const review = await send('post', `/api/strategy-evidence/${id}/reviews`, {
      id: randomUUID(),
      decision: 'approved_research',
      notes: 'Reviewed inputs and results carefully.',
      expectedRevision: 0,
      confirmed: true,
    });
    expect(review.status).toBe(201);
    const stale = await send('post', `/api/strategy-evidence/${id}/reviews`, {
      id: randomUUID(),
      decision: 'revoked',
      notes: 'Stale revision should be refused.',
      expectedRevision: 0,
      confirmed: true,
    });
    expect(stale.status).toBe(409);
    const list = await agent.get('/api/strategy-evidence');
    expect(list.body.items[0].latest_review).toMatchObject({ decision: 'approved_research' });
  });

  it('refuses evidence once the draft has changed', async () => {
    const { send } = await member();
    const { strategy } = (
      await send('post', '/api/strategies', {
        date: '2026-10-09',
        name: 'Crossover draft',
        rules: 'Research moving average crossover entries.',
      })
    ).body;
    const edited = await send('put', `/api/strategies/${strategy.id}`, {
      date: '2026-10-09',
      name: 'Crossover draft',
      rules: 'Changed after the simulation ran.',
    });
    expect(edited.status).toBe(200);
    const response = await send('post', '/api/strategy-evidence', {
      id: randomUUID(),
      snapshot: strategy,
      evidence: evidencePayload(),
    });
    expect(response.status).toBe(409);
  });
});
