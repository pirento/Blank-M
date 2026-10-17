import { describe, expect, it } from 'vitest';
import { MAX_TAGS, normalizeTags, parsePlannedRisk, rMultiple } from '../../shared/trade-tags.js';

describe('trade tags', () => {
  it('cleans, de-duplicates case-insensitively and limits tags', () => {
    expect(normalizeTags(' a ,A,  b  c ,,')).toEqual(['a', 'b c']);
    expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS);
    expect(normalizeTags('x'.repeat(80))[0]).toHaveLength(40);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it('parses planned risk and computes R-multiples', () => {
    expect(parsePlannedRisk('')).toBeNull();
    expect(parsePlannedRisk('250.555')).toBe(250.56);
    expect(parsePlannedRisk('-1')).toBeUndefined();
    expect(parsePlannedRisk('abc')).toBeUndefined();
    expect(rMultiple({ pnl: 500, plannedRisk: 250 })).toBe(2);
    expect(rMultiple({ pnl: -125, plannedRisk: 250 })).toBe(-0.5);
    expect(rMultiple({ pnl: 100, plannedRisk: null })).toBeNull();
    // Without an entered risk, the current stop-loss distance is the risk.
    expect(
      rMultiple({ pnl: 1000, plannedRisk: null, entryPrice: 100, stopLoss: 95, quantity: 200 }),
    ).toBe(1);
  });
});
