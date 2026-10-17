import { describe, expect, it, vi } from 'vitest';
import {
  loadOrderPlans,
  removeOrderPlan,
  saveOrderPlan,
  setOrderPlanReviewed,
  subscribeOrderPlans,
} from '../../shared/order-plans.js';
import { calculateRiskPlan } from '../../shared/risk-calculator.js';
import { DEFAULT_CHARGES } from '../../shared/types.js';
import { useCleanBrowserStorage } from '../helpers/browser-storage.js';

function draft(overrides = {}) {
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
    ...overrides,
  };
  const chargesSnapshot = { ...DEFAULT_CHARGES };
  const result = calculateRiskPlan(inputs, chargesSnapshot);
  if (!result.valid) throw new Error('Invalid fixture');
  return {
    symbol: 'RELIANCE',
    direction: inputs.direction,
    product: inputs.product ?? 'MIS',
    inputs,
    estimate: result.plan,
    chargesSnapshot,
    strategySnapshot: { id: 'strategy-a', name: 'Breakout', rules: 'Wait for confirmation' },
    rulesSnapshot: [{ id: 'rule-a', section: 'Risk', rule: 'Stop after two losses' }],
    quoteSnapshot: {
      symbol: 'RELIANCE',
      price: 99.5,
      currency: 'INR',
      source: 'Test fixture',
      asOf: '2026-10-08T04:00:00.000Z',
      fetchedAt: '2026-10-08T04:00:02.000Z',
    },
  };
}

const ownerPrefix = (owner) => `blank_manual_plans:v1:${encodeURIComponent(owner)}:`;
const planKey = (plan) => `${ownerPrefix(plan.ownerId)}plan:${plan.id}`;

useCleanBrowserStorage();

describe('browser-local manual plans', () => {
  it('round-trips every frozen input and estimate without writing journal data', () => {
    localStorage.setItem('unrelated-journal', 'keep exactly');
    const original = draft({
      priceMode: 'percent',
      stopDistancePercent: '5',
      rewardMultiple: '2',
      estimatedRoundTripCharges: '25.01',
      marginPercent: '20',
    });
    const saved = saveOrderPlan('owner-a', original);
    expect(saved).toMatchObject({
      ...original,
      version: 1,
      ownerId: 'owner-a',
      reviewedAt: null,
      recordKind: 'manual-plan',
    });
    expect(loadOrderPlans('owner-a')).toEqual([saved]);
    expect(localStorage.length).toBe(2);
    expect(localStorage.getItem('unrelated-journal')).toBe('keep exactly');
  });

  it('keeps A and B isolated, including owner identifiers needing escaping', () => {
    const a = saveOrderPlan('owner/a', draft());
    expect(loadOrderPlans('owner%2Fa')).toEqual([]);
    const b = saveOrderPlan('owner%2Fa', draft());
    expect(loadOrderPlans('owner/a')).toEqual([a]);
    expect(loadOrderPlans('owner%2Fa')).toEqual([b]);
    expect(() => removeOrderPlan('owner%2Fa', a.id)).toThrow(/no longer available/);
    expect(() => setOrderPlanReviewed('owner%2Fa', a.id, true)).toThrow(/no longer available/);
    expect(loadOrderPlans('owner/a')).toEqual([a]);
  });

  it('does not read storage while signed out and rejects anonymous mutations', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem');
    expect(loadOrderPlans(null)).toEqual([]);
    expect(loadOrderPlans('')).toEqual([]);
    expect(() => saveOrderPlan('', draft())).toThrow(/Sign in/);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not share mutable draft, returned plan or loaded snapshot references', () => {
    const source = draft();
    const saved = saveOrderPlan('owner-a', source);
    source.inputs.entryPrice = '200';
    source.chargesSnapshot.brokeragePercent = 99;
    source.rulesSnapshot[0].rule = 'Changed later';
    source.strategySnapshot.name = 'Changed later';
    saved.estimate.quantity = 999999;
    const loaded = loadOrderPlans('owner-a')[0];
    expect(loaded.inputs.entryPrice).toBe('100');
    expect(loaded.chargesSnapshot.brokeragePercent).toBe(DEFAULT_CHARGES.brokeragePercent);
    expect(loaded.rulesSnapshot[0].rule).toBe('Stop after two losses');
    expect(loaded.strategySnapshot.name).toBe('Breakout');
    expect(loaded.estimate.quantity).not.toBe(999999);
    loaded.inputs.riskPercent = '50';
    expect(loadOrderPlans('owner-a')[0].inputs.riskPercent).toBe('1');
  });

  it('review changes never overwrite the immutable estimate record', () => {
    const saved = saveOrderPlan('owner-a', draft());
    const bytes = localStorage.getItem(planKey(saved));
    setOrderPlanReviewed('owner-a', saved.id, true);
    const reviewed = loadOrderPlans('owner-a')[0];
    expect(reviewed.reviewedAt).not.toBeNull();
    expect(reviewed.estimate).toEqual(saved.estimate);
    expect(reviewed.chargesSnapshot).toEqual(saved.chargesSnapshot);
    expect(localStorage.getItem(planKey(saved))).toBe(bytes);
    setOrderPlanReviewed('owner-a', saved.id, false);
    expect(loadOrderPlans('owner-a')).toEqual([saved]);
  });

  it('keeps distinct additions and review edits independent across stale tabs', () => {
    const first = saveOrderPlan('owner-a', draft());
    const staleTab = loadOrderPlans('owner-a');
    const second = saveOrderPlan('owner-a', draft({ quantity: '1' }));
    setOrderPlanReviewed('owner-a', staleTab[0].id, true);
    const loaded = loadOrderPlans('owner-a');
    expect(new Set(loaded.map((plan) => plan.id))).toEqual(new Set([first.id, second.id]));
    expect(loaded.find((plan) => plan.id === first.id)?.reviewedAt).not.toBeNull();
    expect(loaded.find((plan) => plan.id === second.id)).toEqual(second);
  });

  it('a permanent tombstone prevents stale data or review writes resurrecting a deletion', () => {
    const removed = saveOrderPlan('owner-a', draft());
    const kept = saveOrderPlan('owner-a', draft({ quantity: '1' }));
    const staleBytes = localStorage.getItem(planKey(removed));
    setOrderPlanReviewed('owner-a', removed.id, true);
    const reviewKey = `${ownerPrefix('owner-a')}review:${removed.id}`;
    const staleReview = localStorage.getItem(reviewKey);
    removeOrderPlan('owner-a', removed.id);
    expect(localStorage.getItem(planKey(removed))).toBeNull();
    localStorage.setItem(planKey(removed), staleBytes);
    localStorage.setItem(reviewKey, staleReview);
    expect(loadOrderPlans('owner-a')).toEqual([kept]);
    expect(() => setOrderPlanReviewed('owner-a', removed.id, true)).toThrow(/no longer available/);
  });

  it('honours committed removal even when optional payload cleanup is denied', () => {
    const saved = saveOrderPlan('owner-a', draft());
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    removeOrderPlan('owner-a', saved.id);
    expect(loadOrderPlans('owner-a')).toEqual([]);
  });

  it.each([
    ['zero quantity', () => draft({ availableCapital: '0.01' })],
    ['over risk', () => draft({ quantity: '1000' })],
    ['over capital', () => draft({ availableCapital: '100', quantity: '10' })],
    [
      'CNC short',
      () =>
        draft({
          direction: 'Short',
          stopLoss: '105',
          takeProfit: '90',
          product: 'CNC',
          estimatedRoundTripCharges: '45',
        }),
    ],
    ['mismatched direction', () => ({ ...draft(), direction: 'Short' })],
    ['mismatched product', () => ({ ...draft(), product: 'CNC' })],
    [
      'delivery without a delivery charge estimate',
      () => {
        const value = draft({ product: 'CNC', estimatedRoundTripCharges: '45' });
        delete value.inputs.estimatedRoundTripCharges;
        return value;
      },
    ],
    [
      'mismatched quote',
      () => {
        const value = draft();
        value.quoteSnapshot.symbol = 'TCS';
        return value;
      },
    ],
    [
      'quote in another currency',
      () => {
        const value = draft();
        value.quoteSnapshot.currency = 'USD';
        return value;
      },
    ],
    ['invalid NSE symbol', () => ({ ...draft(), symbol: 'reliance<script>' })],
    [
      'percentage prices inconsistent with estimate',
      () => draft({ priceMode: 'percent', stopDistancePercent: '2', rewardMultiple: '3' }),
    ],
    [
      'tampered estimate',
      () => {
        const value = draft();
        value.estimate.stopLossIncludingFeesPaise = 0;
        return value;
      },
    ],
    [
      'malformed inputs',
      () => {
        const value = draft();
        value.inputs.entryPrice = 'not a number';
        return value;
      },
    ],
    ['empty symbol', () => ({ ...draft(), symbol: '' })],
  ])('rejects %s without persisting any data', (_label, makeDraft) => {
    expect(() => saveOrderPlan('owner-a', makeDraft())).toThrow(/Only a valid plan/);
    expect(localStorage.length).toBe(0);
  });

  it.each([
    ['malformed JSON', () => '{broken'],
    ['unsupported version', (plan) => JSON.stringify({ ...plan, version: 2 })],
    ['wrong owner', (plan) => JSON.stringify({ ...plan, ownerId: 'owner-b' })],
    ['missing field', (plan) => JSON.stringify({ ...plan, estimate: {} })],
    [
      'unsafe integer',
      (plan) => JSON.stringify({ ...plan, estimate: { ...plan.estimate, quantity: 1e30 } }),
    ],
    [
      'changed estimate',
      (plan) => JSON.stringify({ ...plan, estimate: { ...plan.estimate, stopFeesPaise: 0 } }),
    ],
    [
      'invalid fees',
      (plan) =>
        JSON.stringify({
          ...plan,
          chargesSnapshot: { ...plan.chargesSnapshot, brokeragePercent: -1 },
        }),
    ],
  ])('preserves %s and refuses all subsequent mutations', (_label, corrupt) => {
    const saved = saveOrderPlan('owner-a', draft());
    const raw = corrupt(saved);
    localStorage.setItem(planKey(saved), raw);
    expect(() => loadOrderPlans('owner-a')).toThrow(/preserved/);
    expect(() => saveOrderPlan('owner-a', draft())).toThrow(/preserved/);
    expect(() => removeOrderPlan('owner-a', saved.id)).toThrow(/preserved/);
    expect(() => setOrderPlanReviewed('owner-a', saved.id, true)).toThrow(/preserved/);
    expect(localStorage.getItem(planKey(saved))).toBe(raw);
    expect(localStorage.length).toBe(1);
  });

  it('does not inspect or overwrite unrelated, legacy or other-owner storage', () => {
    localStorage.setItem('blank_manual_plans', '{not ours');
    localStorage.setItem(`${ownerPrefix('owner-b')}plan:anything`, '{broken');
    const saved = saveOrderPlan('owner-a', draft());
    expect(loadOrderPlans('owner-a')).toEqual([saved]);
    expect(localStorage.getItem('blank_manual_plans')).toBe('{not ours');
    expect(localStorage.getItem(`${ownerPrefix('owner-b')}plan:anything`)).toBe('{broken');
  });

  it('surfaces unavailable storage and preserves earlier records on failed writes', () => {
    const saved = saveOrderPlan('owner-a', draft());
    const raw = localStorage.getItem(planKey(saved));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    expect(() => saveOrderPlan('owner-a', draft())).toThrow(/storage permissions/);
    expect(() => setOrderPlanReviewed('owner-a', saved.id, true)).toThrow(/storage permissions/);
    expect(() => removeOrderPlan('owner-a', saved.id)).toThrow(/storage permissions/);
    expect(localStorage.getItem(planKey(saved))).toBe(raw);
    expect(loadOrderPlans('owner-a')).toEqual([saved]);
  });

  it('reports denied reads without silently presenting an empty saved list', () => {
    saveOrderPlan('owner-a', draft());
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    expect(() => loadOrderPlans('owner-a')).toThrow(/storage permissions/);
  });

  it('reports a denied localStorage getter explicitly', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    expect(() => loadOrderPlans('owner-a')).toThrow(/storage permissions/);
    expect(() => saveOrderPlan('owner-a', draft())).toThrow(/storage permissions/);
  });

  it('notifies subscribers only for their own same-tab or cross-tab changes', () => {
    const changed = vi.fn();
    const unsubscribe = subscribeOrderPlans('owner-a', changed);
    saveOrderPlan('owner-b', draft());
    expect(changed).not.toHaveBeenCalled();
    const saved = saveOrderPlan('owner-a', draft());
    expect(changed).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: planKey(saved) }));
    expect(changed).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new StorageEvent('storage', { key: `${ownerPrefix('owner-b')}plan:any` }));
    expect(changed).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(changed).toHaveBeenCalledTimes(3);
    unsubscribe();
    removeOrderPlan('owner-a', saved.id);
    expect(changed).toHaveBeenCalledTimes(3);
  });
});

describe('deleted plan and chronology regressions', () => {
  it('keeps surviving plans usable after a stale tab restores corrupt deleted payloads', () => {
    const removed = saveOrderPlan('owner-a', draft());
    const kept = saveOrderPlan('owner-a', draft({ quantity: '1' }));
    removeOrderPlan('owner-a', removed.id);
    localStorage.setItem(planKey(removed), '{damaged stale plan');
    localStorage.setItem(`${ownerPrefix('owner-a')}review:${removed.id}`, '{damaged stale review');
    expect(loadOrderPlans('owner-a')).toEqual([kept]);
    setOrderPlanReviewed('owner-a', kept.id, true);
    expect(loadOrderPlans('owner-a')[0]?.reviewedAt).not.toBeNull();
    expect(localStorage.getItem(planKey(removed))).toBe('{damaged stale plan');
  });

  it('never hides corruption behind a tombstone owned by another account', () => {
    const saved = saveOrderPlan('owner-a', draft());
    removeOrderPlan('owner-a', saved.id);
    const key = `${ownerPrefix('owner-a')}removed:${saved.id}`;
    const marker = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify({ ...marker, ownerId: 'owner-b' }));
    localStorage.setItem(planKey(saved), '{damaged');
    expect(() => loadOrderPlans('owner-a')).toThrow(/invalid or unsupported/);
  });

  it('sorts valid offset timestamps by instant instead of their displayed local dates', () => {
    const earlier = saveOrderPlan('owner-a', draft());
    const later = saveOrderPlan('owner-a', draft({ quantity: '1' }));
    localStorage.setItem(
      planKey(earlier),
      JSON.stringify({ ...earlier, createdAt: '2026-10-09T01:00:00+05:30' }),
    );
    localStorage.setItem(
      planKey(later),
      JSON.stringify({ ...later, createdAt: '2026-10-08T23:00:00Z' }),
    );
    expect(loadOrderPlans('owner-a').map((plan) => plan.id)).toEqual([later.id, earlier.id]);
  });
});
