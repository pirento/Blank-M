import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn() }));
import {
  requestBriefing,
  requestPicksWithSources,
  requestResearchHistory,
} from '../../public/js/lib/ai.js';
const universe = {
  name: 'NIFTY 500',
  sourceUrl: 'https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv',
  fetchedAt: '2026-10-08T00:00:00.000Z',
  expiresAt: '2026-10-08T06:00:00.000Z',
  version: `sha256:${'a'.repeat(64)}`,
  constituentCount: 500,
};
const analysis = {
  id: '22222222-2222-4222-8222-222222222222',
  requestId: '11111111-1111-4111-8111-111111111111',
  startedAt: '2026-10-08T00:00:00.000Z',
  finishedAt: '2026-10-08T00:01:00.000Z',
};
const response = {
  universe,
  analysis,
  picks: [
    {
      symbol: 'INFY',
      reason: 'Review filing',
      detailedNews: 'Reported context',
      citations: [{ title: 'Filing', url: 'https://example.com/filing' }],
    },
  ],
  sources: [{ title: 'Search source', url: 'https://example.com/search' }],
};
const options = {
  strategies: 'Captured strategy',
  rules: 'Captured rule',
  count: 10,
  requestId: analysis.requestId,
};
beforeEach(() => {
  mocks.session.mockResolvedValue({ data: { session: { access_token: 'unit-test-token' } } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('research request client', () => {
  it('loads bounded owner history pages with the server cursor and no AI request', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ runs: [], maxRuns: 50, nextCursor: null }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(requestResearchHistory(undefined, analysis.id)).resolves.toEqual({
      runs: [],
      maxRuns: 50,
      nextCursor: null,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/api/research/runs?cursor=${analysis.id}`,
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
  });
  it('returns both citation levels', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () => new Response(JSON.stringify(response), { status: 200 })),
    );
    await expect(requestPicksWithSources(options)).resolves.toEqual(response);
  });
  it('does not dispatch under later authentication after cancellation', async () => {
    let resolve;
    mocks.session.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const pending = requestPicksWithSources(options, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    resolve({ data: { session: { access_token: 'replacement-session' } } });
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('forwards cancellation to the briefing transport', async () => {
    const fetch = vi.fn().mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const pending = requestBriefing({ strategies: '', rules: '' }, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
  });
});

it('rejects a receipt belonging to a different request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...response,
          analysis: { ...analysis, requestId: '33333333-3333-4333-8333-333333333333' },
        }),
        { status: 200 },
      ),
    ),
  );
  await expect(requestPicksWithSources(options)).rejects.toThrow('did not match');
});
