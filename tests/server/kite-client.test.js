// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const connection = vi.hoisted(() => ({ invalidate: vi.fn(), active: vi.fn() }));
vi.mock('../../services/market/kite/connection.js', async (original) => ({
  ...(await original()),
  invalidateConnection: connection.invalidate,
  activeConnection: connection.active,
}));

const { kiteFetch } = await import('../../services/market/kite/client.js');
const { kiteProvider, resetKiteMarketDataPause } =
  await import('../../services/market/kite/market-data.js');

const session = { accessToken: 'token', ciphertext: 'cipher' };
const reply = (status, body) => {
  globalThis.fetch = vi.fn(async () => Response.json(body, { status }));
};

beforeEach(() => {
  connection.invalidate.mockReset();
  connection.active.mockReset().mockResolvedValue(session);
  resetKiteMarketDataPause();
});

describe('Kite authorisation failures', () => {
  it('disconnects only when the token itself is rejected', async () => {
    reply(403, { status: 'error', error_type: 'TokenException', message: 'Invalid session' });
    await expect(kiteFetch('/quote', session, 'u1')).rejects.toMatchObject({ status: 401 });
    expect(connection.invalidate).toHaveBeenCalledWith('u1', 'cipher');
  });

  it('keeps the session when the app lacks a permission (Personal plan)', async () => {
    reply(403, {
      status: 'error',
      error_type: 'PermissionException',
      message: 'Insufficient permission for that call.',
    });
    await expect(kiteFetch('/quote', session, 'u1')).rejects.toMatchObject({
      status: 403,
      permissionDenied: true,
      message: 'Zerodha denied the request: Insufficient permission for that call.',
    });
    expect(connection.invalidate).not.toHaveBeenCalled();
  });

  it('stops asking Kite for quotes after a permission refusal', async () => {
    reply(403, { status: 'error', error_type: 'PermissionException', message: 'No quotes' });
    expect(await kiteProvider.isAvailable('u1')).toBe(true);
    await expect(kiteProvider.fetchQuote('INFY', 'u1')).rejects.toMatchObject({ status: 403 });
    expect(await kiteProvider.isAvailable('u1')).toBe(false);
  });
});
