import {
  DEFAULT_BACKTEST_CONFIG,
  DEFAULT_STRATEGY_PARAMS,
  runBacktest,
} from '../../shared/backtest/engine.js';

export const evidenceOwner = '11111111-1111-4111-8111-111111111111';
export const evidenceStrategy = {
  id: '33333333-3333-4333-8333-333333333333',
  date: '2026-10-09',
  name: 'Crossover draft',
  rules: 'Research moving average crossover entries.',
  improvements: '',
  notes: 'Synthetic test fixture.',
  createdAt: '2026-10-09T01:00:00Z',
};
export function evidencePayload() {
  const candles = Array.from({ length: 80 }, (_, index) => ({
    time: Date.parse('2026-01-01T00:00:00Z') + index * 86400000,
    open: 100 + (index % 10),
    high: 113,
    low: 98,
    close: 101 + (index % 10),
    volume: 1000,
  }));
  const params = { ...DEFAULT_STRATEGY_PARAMS, fastPeriod: 2, slowPeriod: 4 };
  const config = { ...DEFAULT_BACKTEST_CONFIG, charges: { ...DEFAULT_BACKTEST_CONFIG.charges } };
  return {
    schemaVersion: 1,
    engineVersion: 'blank-daily-long-v1',
    provenance: 'client-computed-unverified',
    symbol: 'TCS',
    from: '2026-01-01',
    to: '2026-04-01',
    params,
    config,
    candles,
    result: runBacktest(candles, params, config),
  };
}
export function evidenceRecord() {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    user_id: evidenceOwner,
    strategy_id: evidenceStrategy.id,
    strategy_snapshot: { ...evidenceStrategy },
    strategy_hash: 'a'.repeat(64),
    evidence: evidencePayload(),
    evidence_hash: 'b'.repeat(64),
    server_revision: 1,
    created_at: '2026-10-09T02:00:00Z',
    latest_review: null,
  };
}
export function evidenceReview() {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    user_id: evidenceOwner,
    evidence_id: evidenceRecord().id,
    decision: 'approved_research',
    notes: 'Reviewed the exact draft and simulation.',
    expected_review_revision: 0,
    server_revision: 2,
    created_at: '2026-10-09T03:00:00Z',
  };
}
