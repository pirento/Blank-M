// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/market/kite/config.js', async (original) => ({
  ...(await original()),
  isKiteConfigured: () => true,
}));
vi.mock('../../services/market/kite/connection.js', () => ({
  loadConnection: async () => ({
    brokerUserId: 'AB1234',
    accessToken: 'token',
    expiresAt: new Date(Date.now() + 3_600_000),
  }),
}));
vi.mock('../../services/market/kite/client.js', () => ({
  kiteFetch: async () => ({ status: 'success', data: { user_id: 'AB1234' } }),
  throwAuthFailure: async () => {
    throw new Error('auth');
  },
}));

const { placeKiteLimitOrder } = await import('../../services/market/kite/orders.js');
const { nextTokenExpiry } = await import('../../services/market/kite/session.js');

const ORDER = { symbol: 'INFY', side: 'BUY', product: 'MIS', quantity: 1, price: '1500', tag: 't' };
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.KITE_API_KEY = 'key';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.KITE_API_KEY;
});

describe('Kite order outcomes', () => {
  it('treats a Kite server error or a missing order ID as unknown, never as rejected', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ status: 'error' }, { status: 503 }));
    await expect(placeKiteLimitOrder('u1', ORDER)).rejects.toMatchObject({ outcome: 'unknown' });
    globalThis.fetch = vi.fn(async () => Response.json({ status: 'success', data: {} }));
    await expect(placeKiteLimitOrder('u1', ORDER)).rejects.toMatchObject({ outcome: 'unknown' });
    // A real rejection (4xx with Kite's message) stays a rejection.
    globalThis.fetch = vi.fn(async () =>
      Response.json({ status: 'error', message: 'Insufficient funds' }, { status: 400 }),
    );
    const rejected = await placeKiteLimitOrder('u1', ORDER).catch((error) => error);
    expect(rejected.outcome).toBeUndefined();
    expect(rejected.message).toMatch(/Insufficient funds/);
  });

  it('expires a token at the next 06:00 IST', () => {
    // 02:00 IST → 06:00 IST the same day; 10:00 IST → 06:00 IST the next day.
    expect(nextTokenExpiry(new Date('2026-10-19T20:30:00Z')).toISOString()).toBe(
      '2026-10-20T00:30:00.000Z',
    );
    expect(nextTokenExpiry(new Date('2026-10-20T04:30:00Z')).toISOString()).toBe(
      '2026-10-21T00:30:00.000Z',
    );
  });
});
