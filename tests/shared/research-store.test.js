import { describe, expect, it, vi } from 'vitest';
import {
  readResearchArchive,
  researchCitations,
  researchStorageKey,
  saveResearchRun,
  localCompletionSupersedesPending,
} from '../../public/js/lib/research-store.js';
import { useCleanBrowserStorage } from '../helpers/browser-storage.js';

function run(id = 'request-a', ownerId = 'account-a') {
  return {
    id,
    ownerId,
    startedAt: '2026-10-08T04:00:00Z',
    finishedAt: '2026-10-08T04:00:02Z',
    outcome: 'completed',
    inputs: {
      businessDate: '2026-10-08',
      strategies: [{ id: 'strategy-a', name: 'Breakout', rules: 'Require volume confirmation' }],
      rules: [
        { id: 'rule-a', section: 'Risk', definition: 'Position risk', rule: 'Maximum one percent' },
      ],
      openingBalance: 100000,
      journalBalance: 100500,
      requestedCandidates: 10,
    },
    picks: [
      {
        symbol: 'INFY',
        reason: 'Observed report',
        detailedNews: 'Review source',
        citations: [{ title: 'Company filing', url: 'https://example.com/filing' }],
      },
    ],
    sources: [{ title: 'Market source', url: 'https://example.com/market' }],
  };
}
useCleanBrowserStorage();

describe('browser research archive', () => {
  it('only advances a pending cloud row using its matching completion receipt', () => {
    const local = run('11111111-1111-4111-8111-111111111111');
    local.analysis = {
      id: '22222222-2222-4222-8222-222222222222',
      requestId: local.id,
      startedAt: local.startedAt,
      finishedAt: local.finishedAt,
    };
    local.universe = {
      name: 'NIFTY 500',
      sourceUrl: 'https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv',
      fetchedAt: '2026-10-08T00:00:00Z',
      expiresAt: '2026-10-08T06:00:00Z',
      version: `sha256:${'a'.repeat(64)}`,
      constituentCount: 500,
    };
    const cloud = {
      id: local.analysis.id,
      requestId: local.id,
      ownerId: local.ownerId,
      startedAt: local.startedAt,
      finishedAt: null,
      outcome: 'pending',
      inputs: { strategies: '', rules: '', count: 10 },
      universe: { metadata: local.universe, constituents: [] },
      picks: [],
      sources: [],
    };
    expect(localCompletionSupersedesPending(local, cloud)).toBe(true);
    expect(localCompletionSupersedesPending({ ...local, analysis: undefined }, cloud)).toBe(false);
    expect(localCompletionSupersedesPending(local, { ...cloud, outcome: 'failed' })).toBe(false);
    expect(localCompletionSupersedesPending(local, { ...cloud, ownerId: 'another' })).toBe(false);
    expect(localCompletionSupersedesPending(local, { ...cloud, id: 'another' })).toBe(false);
    expect(
      localCompletionSupersedesPending(local, {
        ...cloud,
        universe: {
          ...cloud.universe,
          metadata: { ...cloud.universe.metadata, version: `sha256:${'b'.repeat(64)}` },
        },
      }),
    ).toBe(false);
  });
  it('roundtrips captured inputs, outcomes and both citation levels per owner', () => {
    const saved = run();
    expect(saveResearchRun('account-a', saved)).toBe(true);
    expect(readResearchArchive('account-a').runs).toEqual([saved]);
    expect(readResearchArchive('account-b').runs).toEqual([]);
    expect(saveResearchRun('account-b', saved)).toBe(false);
    expect(readResearchArchive('account-a').runs[0]?.inputs.strategies[0]?.rules).toBe(
      'Require volume confirmation',
    );
  });
  it('keeps pending requests unknown without inventing a final result or interrupting other tabs', () => {
    const pending = { ...run(), outcome: 'pending', finishedAt: null };
    saveResearchRun('account-a', pending);
    saveResearchRun('account-a', run('another-request'));
    expect(readResearchArchive('account-a').runs[1]).toEqual(pending);
  });
  it('replaces one request by identity and retains only the latest twenty', () => {
    for (let index = 0; index < 24; index += 1)
      expect(saveResearchRun('account-a', run(String(index)))).toBe(true);
    expect(readResearchArchive('account-a').runs).toHaveLength(20);
    expect(readResearchArchive('account-a').runs[0]?.id).toBe('23');
    expect(
      saveResearchRun('account-a', { ...run('23'), outcome: 'failed', picks: [], sources: [] }),
    ).toBe(true);
    expect(readResearchArchive('account-a').runs).toHaveLength(20);
    expect(readResearchArchive('account-a').runs[0]?.outcome).toBe('failed');
  });
  it.each([
    '{broken',
    JSON.stringify({ version: 2, ownerId: 'account-a', runs: [] }),
    JSON.stringify({ version: 1, ownerId: 'account-b', runs: [run()] }),
    JSON.stringify({ version: 1, ownerId: 'account-a', runs: [run('x', 'account-b')] }),
  ])('preserves unreadable or wrong-owner bytes: %s', (raw) => {
    localStorage.setItem(researchStorageKey('account-a'), raw);
    expect(readResearchArchive('account-a')).toEqual({ readable: false, runs: [] });
    expect(saveResearchRun('account-a', run())).toBe(false);
    expect(localStorage.getItem(researchStorageKey('account-a'))).toBe(raw);
  });
  it('reports denied reads and failed writes without affecting other keys', () => {
    localStorage.setItem('legacy_private_data', 'preserve');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(saveResearchRun('account-a', run())).toBe(false);
    expect(localStorage.getItem('legacy_private_data')).toBe('preserve');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readResearchArchive('account-a').readable).toBe(false);
  });
  it('does not turn unsafe, credential-bearing or duplicate citation URLs into links', () => {
    const items = [
      'javascript:alert(1)',
      'data:text/html,hello',
      'ftp://example.com/file',
      'https://user:password@example.com',
      'https://example.com/source',
      'https://example.com/source',
      'http://example.com/another',
    ].map((url) => ({ title: 'Source', url }));
    expect(researchCitations(items).map((item) => item.url)).toEqual([
      'https://example.com/source',
      'http://example.com/another',
    ]);
  });
});
