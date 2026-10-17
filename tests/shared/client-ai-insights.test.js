import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn() }));
import { requestInsights } from '../../public/js/lib/ai.js';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ data: { session: { access_token: 'synthetic-test-token' } } });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('does not call fetch when already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(requestInsights('synthetic report', controller.signal)).rejects.toMatchObject({
    code: 'cancelled',
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('cancels during session preparation and does not start a late request', async () => {
  let resolve;
  mocks.session.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const controller = new AbortController();
  const pending = requestInsights('synthetic report', controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  resolve({ data: { session: { access_token: 'synthetic-test-token' } } });
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
});
it('cancels while reading JSON even if the transport ignores abort', async () => {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const pending = requestInsights('synthetic report', controller.signal);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
});
it('bounds the entire response body read by the request timeout', async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: () => new Promise(() => {}),
  });
  const pending = requestInsights('synthetic report');
  const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(120_000);
  await rejected;
});
it('validates and returns a mocked complete response', async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ text: 'Synthetic report insight' })),
  );
  await expect(requestInsights('synthetic report')).resolves.toBe('Synthetic report insight');
});
