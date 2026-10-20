import { describe, expect, it, vi } from 'vitest';
import {
  exportOrderPlanRecords,
  loadOrderPlans,
  mergeOrderPlanRecords,
  removeOrderPlan,
  saveOrderPlan,
  setOrderPlanReviewed,
} from '../../shared/order-plans.js';
import { calculateRiskPlan } from '../../shared/risk-calculator.js';
import { DEFAULT_CHARGES } from '../../shared/types.js';
import {
  readCloudOrderPlanRecords,
  subscribeOrderPlanSync,
  synchronizeOrderPlans,
} from '../../public/js/lib/order-plan-sync.js';
import { useCleanBrowserStorage } from '../helpers/browser-storage.js';

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const clone = (value) => JSON.parse(JSON.stringify(value));

function draft(symbol = 'TCS') {
  const inputs = {
    direction: 'Long',
    accountSize: '100000',
    riskPercent: '1',
    entryPrice: '100',
    stopLoss: '95',
    product: 'MIS',
  };
  const result = calculateRiskPlan(inputs, DEFAULT_CHARGES);
  if (!result.valid) throw new Error('Invalid fixture');
  return {
    symbol,
    direction: 'Long',
    product: 'MIS',
    inputs,
    estimate: result.plan,
    chargesSnapshot: DEFAULT_CHARGES,
    rulesSnapshot: [],
    strategySnapshot: null,
    quoteSnapshot: null,
  };
}

function backend(initial = [], pageCap = 50) {
  const rows = initial.map((row, index) => ({
    ...clone(row),
    server_revision: index + 1,
  }));
  let revision = rows.length;
  const transport = {
    requireActiveOwner: vi.fn(async () => {}),
    page: vi.fn(async (account, offset, limit) => {
      const owned = rows.filter((row) => row.user_id === account);
      return {
        rows: clone(owned.slice(offset, offset + Math.min(limit, pageCap))),
        count: owned.length,
      };
    }),
    insert: vi.fn(async (row) => {
      if (
        !rows.some((saved) => saved.user_id === row.user_id && saved.record_key === row.record_key)
      ) {
        rows.push({ ...clone(row), server_revision: ++revision });
      }
    }),
    subscribe: vi.fn(() => () => {}),
  };
  return { rows, transport };
}

useCleanBrowserStorage();

describe('private cloud order-plan synchronization', () => {
  it('preserves every frozen field across a fresh device and never uploads another owner', async () => {
    const plan = saveOrderPlan(owner, draft());
    saveOrderPlan(other, draft('RELIANCE'));
    const cloud = backend();
    expect(await synchronizeOrderPlans(owner, cloud.transport, () => true)).toBe(true);
    expect(cloud.rows).toHaveLength(1);
    expect(cloud.rows[0].record).toEqual(plan);
    localStorage.clear();
    expect(await synchronizeOrderPlans(owner, cloud.transport, () => true)).toBe(true);
    expect(loadOrderPlans(owner)).toEqual([plan]);
    expect(loadOrderPlans(other)).toEqual([]);
  });

  it('retries the same stable UUID after a committed upload loses its response', async () => {
    saveOrderPlan(owner, draft());
    const cloud = backend();
    const insert = cloud.transport.insert;
    cloud.transport.insert = vi.fn(async (row) => {
      await insert(row);
      throw new Error('Connection lost');
    });
    await expect(synchronizeOrderPlans(owner, cloud.transport, () => true)).rejects.toThrow(
      'Connection lost',
    );
    cloud.transport.insert = insert;
    expect(await synchronizeOrderPlans(owner, cloud.transport, () => true)).toBe(true);
    expect(cloud.rows).toHaveLength(1);
    expect(loadOrderPlans(owner)).toHaveLength(1);
  });

  it('appends review changes and uses server revision rather than device clock order', async () => {
    const plan = saveOrderPlan(owner, draft());
    const cloud = backend();
    await synchronizeOrderPlans(owner, cloud.transport, () => true);
    setOrderPlanReviewed(owner, plan.id, true);
    await synchronizeOrderPlans(owner, cloud.transport, () => true);
    const old = localStorage.getItem(`blank_manual_plans:v1:${owner}:review:${plan.id}`);
    setOrderPlanReviewed(owner, plan.id, false);
    await synchronizeOrderPlans(owner, cloud.transport, () => true);
    localStorage.setItem(`blank_manual_plans:v1:${owner}:review:${plan.id}`, old);
    await synchronizeOrderPlans(owner, cloud.transport, () => true);
    expect(cloud.rows.filter((row) => row.record_kind === 'review')).toHaveLength(2);
    expect(loadOrderPlans(owner)[0].reviewedAt).toBeNull();
    expect(cloud.rows.find((row) => row.record_kind === 'plan').record).toEqual(plan);
  });

  it('does not overwrite a new local review while a cloud download is pending', async () => {
    const plan = saveOrderPlan(owner, draft());
    const cloud = backend();
    await synchronizeOrderPlans(owner, cloud.transport, () => true);
    setOrderPlanReviewed(owner, plan.id, true);
    await synchronizeOrderPlans(owner, cloud.transport, () => true);
    const before = clone(cloud.rows);
    setOrderPlanReviewed(owner, plan.id, false);
    mergeOrderPlanRecords(owner, before);
    expect(loadOrderPlans(owner)[0].reviewedAt).toBeNull();
    await synchronizeOrderPlans(owner, cloud.transport, () => true);
    expect(cloud.rows.at(-1).record.reviewedAt).toBeNull();
  });

  it('synchronizes permanent removals and ignores stale reviews or plan payloads', async () => {
    const plan = saveOrderPlan(owner, draft());
    const cloud = backend();
    await synchronizeOrderPlans(owner, cloud.transport, () => true);
    const savedBytes = JSON.stringify(plan);
    removeOrderPlan(owner, plan.id);
    await synchronizeOrderPlans(owner, cloud.transport, () => true);
    localStorage.clear();
    localStorage.setItem(`blank_manual_plans:v1:${owner}:plan:${plan.id}`, savedBytes);
    setOrderPlanReviewed(owner, plan.id, true);
    expect(await synchronizeOrderPlans(owner, cloud.transport, () => true)).toBe(true);
    expect(loadOrderPlans(owner)).toEqual([]);
    expect(cloud.rows.filter((row) => row.record_kind === 'review')).toHaveLength(0);
    expect(cloud.rows.filter((row) => row.record_kind === 'removed')).toHaveLength(1);
  });

  it('converges removals independently made on two devices with different timestamps', async () => {
    const plan = saveOrderPlan(owner, draft());
    removeOrderPlan(owner, plan.id);
    const cloud = backend(exportOrderPlanRecords(owner));
    cloud.rows[0].record.removedAt = '2026-01-01T00:00:00.000Z';
    expect(await synchronizeOrderPlans(owner, cloud.transport, () => true)).toBe(true);
    expect(loadOrderPlans(owner)).toEqual([]);
  });

  it('lets a cloud tombstone win even if a stale device retained a different valid plan payload', async () => {
    const plan = saveOrderPlan(owner, draft());
    const cloud = backend(exportOrderPlanRecords(owner));
    removeOrderPlan(owner, plan.id);
    await synchronizeOrderPlans(owner, cloud.transport, () => true);
    localStorage.clear();
    localStorage.setItem(
      `blank_manual_plans:v1:${owner}:plan:${plan.id}`,
      JSON.stringify({ ...plan, symbol: 'RELIANCE' }),
    );
    expect(await synchronizeOrderPlans(owner, cloud.transport, () => true)).toBe(true);
    expect(loadOrderPlans(owner)).toEqual([]);
  });

  it('upgrades a legacy review once and preserves its retry identity', () => {
    const plan = saveOrderPlan(owner, draft());
    const key = `blank_manual_plans:v1:${owner}:review:${plan.id}`;
    localStorage.setItem(
      key,
      JSON.stringify({
        id: plan.id,
        ownerId: owner,
        version: 1,
        recordKind: 'manual-plan-review',
        reviewedAt: null,
      }),
    );
    const first = exportOrderPlanRecords(owner);
    expect(exportOrderPlanRecords(owner)).toEqual(first);
    expect(first.find((row) => row.record_kind === 'review').record_key).toMatch(/review:.+:.+/);
  });

  it('rejects a conflicting immutable cloud snapshot without overwriting either copy', async () => {
    const plan = saveOrderPlan(owner, draft());
    const cloud = backend(exportOrderPlanRecords(owner));
    cloud.rows[0].record.symbol = 'RELIANCE';
    await expect(synchronizeOrderPlans(owner, cloud.transport, () => true)).rejects.toThrow(
      /conflicts/,
    );
    expect(loadOrderPlans(owner)).toEqual([plan]);
    expect(cloud.transport.insert).not.toHaveBeenCalled();
  });

  it('verifies UUID conflicts after an ignored insert instead of falsely acknowledging', async () => {
    saveOrderPlan(owner, draft());
    const cloud = backend();
    const insert = cloud.transport.insert;
    cloud.transport.insert = async (row) => {
      const altered = clone(row);
      altered.record.symbol = 'RELIANCE';
      await insert(altered);
    };
    await expect(synchronizeOrderPlans(owner, cloud.transport, () => true)).rejects.toThrow(
      /acknowledgment/,
    );
    expect(loadOrderPlans(owner)[0].symbol).toBe('TCS');
  });

  it('fetches all counted pages even when the project row cap is lower than requested', async () => {
    for (let index = 0; index < 7; index++) saveOrderPlan(owner, draft());
    const cloud = backend(exportOrderPlanRecords(owner), 2);
    localStorage.clear();
    await synchronizeOrderPlans(owner, cloud.transport, () => true);
    expect(loadOrderPlans(owner)).toHaveLength(7);
    expect(cloud.transport.page).toHaveBeenCalledTimes(4);
    expect(cloud.transport.page).toHaveBeenLastCalledWith(owner, 6, 50);
  });

  it.each([
    'wrong-owner',
    'invalid-economics',
    'duplicate-key',
    'unsafe-revision',
    'missing-count',
    'empty-page',
    'changing-count',
  ])('fails closed before cache writes for %s', async (failure) => {
    saveOrderPlan(owner, draft());
    saveOrderPlan(owner, draft());
    const cloud = backend(exportOrderPlanRecords(owner), 1);
    localStorage.clear();
    if (failure === 'wrong-owner') cloud.rows[0].user_id = other;
    if (failure === 'invalid-economics') cloud.rows[0].record.estimate.quantity = 1;
    if (failure === 'duplicate-key') cloud.rows[1].record_key = cloud.rows[0].record_key;
    if (failure === 'unsafe-revision') cloud.rows[0].server_revision = Number.MAX_SAFE_INTEGER + 1;
    const page = cloud.transport.page;
    cloud.transport.page = async (account, offset, limit) => {
      const response = await page(account, offset, limit);
      if (failure === 'wrong-owner') return { rows: [clone(cloud.rows[0])], count: 1 };
      if (failure === 'missing-count') response.count = null;
      if (failure === 'empty-page') response.rows = [];
      if (failure === 'changing-count' && offset) response.count = 3;
      return response;
    };
    await expect(synchronizeOrderPlans(owner, cloud.transport, () => true)).rejects.toThrow();
    expect(localStorage.length).toBe(0);
  });

  it('ignores responses after an account session is disposed', async () => {
    saveOrderPlan(owner, draft());
    const cloud = backend(exportOrderPlanRecords(owner));
    localStorage.clear();
    let active = true;
    const page = cloud.transport.page;
    cloud.transport.page = async (...args) => {
      const response = await page(...args);
      active = false;
      return response;
    };
    await expect(synchronizeOrderPlans(owner, cloud.transport, () => active)).rejects.toThrow(
      /session changed/,
    );
    expect(localStorage.length).toBe(0);
  });

  it('requests another pass for a plan added while an earlier upload was pending', async () => {
    saveOrderPlan(owner, draft());
    const cloud = backend();
    const insert = cloud.transport.insert;
    cloud.transport.insert = async (row) => {
      await insert(row);
      saveOrderPlan(owner, draft('RELIANCE'));
    };
    expect(await synchronizeOrderPlans(owner, cloud.transport, () => true)).toBe(false);
    expect(loadOrderPlans(owner)).toHaveLength(2);
  });

  it('does not read cloud data or alter retry identities for an already disposed account', async () => {
    const cloud = backend();
    await expect(readCloudOrderPlanRecords(owner, cloud.transport, () => false)).rejects.toThrow(
      /session changed/,
    );
    expect(cloud.transport.page).not.toHaveBeenCalled();
  });

  it('does not claim a revoked or different session has an empty synced cloud history', async () => {
    const cloud = backend();
    cloud.transport.requireActiveOwner = vi.fn(async () => {
      throw new Error('Active workspace access is required');
    });
    await expect(synchronizeOrderPlans(owner, cloud.transport, () => true)).rejects.toThrow(
      /Active workspace/,
    );
    expect(cloud.transport.page).not.toHaveBeenCalled();
  });

  it('rechecks membership before merging a response that arrived after revocation', async () => {
    saveOrderPlan(owner, draft());
    const cloud = backend(exportOrderPlanRecords(owner));
    localStorage.clear();
    vi.mocked(cloud.transport.requireActiveOwner)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('Access revoked'));
    await expect(synchronizeOrderPlans(owner, cloud.transport, () => true)).rejects.toThrow(
      /revoked/,
    );
    expect(localStorage.length).toBe(0);
  });

  it('shares one worker between consumers and stops all future work after unsubscription', async () => {
    const cloud = backend();
    const firstStates = [];
    const first = subscribeOrderPlanSync(
      owner,
      (state) => firstStates.push(state),
      cloud.transport,
    );
    const second = subscribeOrderPlanSync(owner, () => {}, cloud.transport);
    await vi.waitFor(() => expect(firstStates.at(-1)?.state).toBe('synced'));
    expect(cloud.transport.subscribe).toHaveBeenCalledTimes(1);
    first.unsubscribe();
    const calls = vi.mocked(cloud.transport.page).mock.calls.length;
    second.unsubscribe();
    first.retry();
    second.retry();
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(cloud.transport.page).toHaveBeenCalledTimes(calls);
  });

  it('invalidates an in-flight worker immediately when the authenticated identity changes', async () => {
    saveOrderPlan(owner, draft());
    const cloud = backend(exportOrderPlanRecords(owner));
    localStorage.clear();
    let invalidate = () => {};
    cloud.transport.subscribe = (_owner, _changed, _failed, invalidated) => {
      invalidate = invalidated;
      return () => {};
    };
    let resolvePage;
    cloud.transport.page = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    );
    const statuses = [];
    const subscription = subscribeOrderPlanSync(
      owner,
      (value) => statuses.push(value),
      cloud.transport,
    );
    await vi.waitFor(() => expect(cloud.transport.page).toHaveBeenCalledOnce());
    invalidate();
    resolvePage({ rows: clone(cloud.rows), count: cloud.rows.length });
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe('error'));
    await Promise.resolve();
    expect(localStorage.length).toBe(0);
    expect(statuses.at(-1)?.error).toMatch(/account changed/);
    subscription.unsubscribe();
  });
});

describe('incremental cloud reads', () => {
  it('downloads only new records after the first full read, and falls back when counts disagree', async () => {
    const cloud = backend();
    cloud.transport.pageAfter = vi.fn(async (account, after, limit) => {
      const owned = cloud.rows.filter((row) => row.user_id === account);
      return {
        rows: clone(owned.filter((row) => row.server_revision > after).slice(0, limit)),
        count: owned.length,
      };
    });
    const owner2 = '00000000-0000-4000-8000-0000000000a2';
    saveOrderPlan(owner2, draft());
    await synchronizeOrderPlans(owner2, cloud.transport, () => true);
    const fullReads = cloud.transport.page.mock.calls.length;

    saveOrderPlan(owner2, draft('RELIANCE'));
    await synchronizeOrderPlans(owner2, cloud.transport, () => true);
    // No more full reads: only the records after the cached revision were fetched.
    expect(cloud.transport.page.mock.calls.length).toBe(fullReads);
    expect(cloud.transport.pageAfter).toHaveBeenCalled();
    const rows = await readCloudOrderPlanRecords(owner2, cloud.transport, () => true);
    expect(rows).toHaveLength(2);

    // A record that appears with an older revision makes the counts disagree: full read again.
    cloud.rows.unshift({ ...clone(cloud.rows[0]), record_key: 'late-key', server_revision: 0.5 });
    await readCloudOrderPlanRecords(owner2, cloud.transport, () => true).catch(() => undefined);
    expect(cloud.transport.page.mock.calls.length).toBeGreaterThan(fullReads);
  });
});
