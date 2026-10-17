import { describe, expect, it } from 'vitest';
import { evidencePayload, evidenceStrategy } from '../fixtures/strategy-evidence.js';
import {
  validateStrategyEvidence,
  matchesStrategySnapshot,
} from '../../shared/strategy-evidence.js';
describe('immutable strategy evidence', () => {
  it('retains and reproduces full daily-candle inputs and charged results', () => {
    const value = evidencePayload();
    expect(validateStrategyEvidence(evidenceStrategy, value)).toEqual(value);
    expect(value.result.trades.length).toBeGreaterThan(0);
  });
  it('rejects fabricated result metrics', () => {
    const value = evidencePayload();
    value.result.metrics.netProfit += 100;
    expect(() => validateStrategyEvidence(evidenceStrategy, value)).toThrow('no longer match');
  });
  it('rejects candles outside the frozen date range', () => {
    const value = evidencePayload();
    value.from = '2026-02-01';
    expect(() => validateStrategyEvidence(evidenceStrategy, value)).toThrow('completed date range');
  });
  it('rejects excessive candle counts', () => {
    const value = evidencePayload();
    value.candles = Array.from({ length: 3001 }, () => value.candles[0]);
    expect(() => validateStrategyEvidence(evidenceStrategy, value)).toThrow();
  });
  it('rejects oversized draft snapshots', () => {
    expect(() =>
      validateStrategyEvidence(
        { ...evidenceStrategy, notes: 'x'.repeat(31000) },
        evidencePayload(),
      ),
    ).toThrow('limit');
  });
  it('rejects unsupported evidence certification claims', () => {
    expect(() =>
      validateStrategyEvidence(evidenceStrategy, { ...evidencePayload(), provenance: 'verified' }),
    ).toThrow();
  });
  it('rejects NaN and infinite metric inputs', () => {
    const value = evidencePayload();
    value.result.metrics.profitFactor = Infinity;
    expect(() => validateStrategyEvidence(evidenceStrategy, value)).toThrow();
  });
  it('normalizes equivalent timestamp formatting when comparing a frozen draft', () => {
    expect(
      matchesStrategySnapshot(
        { ...evidenceStrategy, createdAt: '2026-10-09T01:00:00.000+00:00' },
        evidenceStrategy,
      ),
    ).toBe(true);
  });
  it.each(['id', 'rules', 'notes', 'name', 'improvements', 'date'])(
    'a changed %s never inherits an old approval',
    (field) => {
      expect(
        matchesStrategySnapshot({ ...evidenceStrategy, [field]: 'changed' }, evidenceStrategy),
      ).toBe(false);
    },
  );
  it('deleted drafts cannot inherit approval', () => {
    expect(matchesStrategySnapshot(undefined, evidenceStrategy)).toBe(false);
  });
});
