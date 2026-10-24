// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const broker = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../services/broker/portfolio.js', async (original) => ({
  ...(await original()),
  readBrokerPortfolio: broker.read,
}));

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);

const fill = (tradeId, side, quantity, price, minute) => ({
  symbol: 'INFY',
  exchange: 'NSE',
  product: 'MIS',
  tradeId,
  orderId: `O${tradeId}`,
  side,
  quantity,
  averagePrice: price,
  filledAt: `2026-10-05T04:${String(minute).padStart(2, '0')}:00.000Z`,
});

beforeEach(async () => {
  await resetDatabase();
  broker.read.mockReset().mockImplementation(async (_userId, assertAccess) => {
    await assertAccess();
    return {
      tradingDate: '2026-10-05',
      fetchedAt: '2026-10-05T10:00:00.000Z',
      trades: [
        fill('1', 'BUY', 10, 1500, 1),
        fill('2', 'SELL', 10, 1520, 2),
        fill('3', 'SELL', 5, 1530, 3),
        { ...fill('4', 'BUY', 50, 20, 4), symbol: 'GOLD26OCTFUT', exchange: 'MCX' },
      ],
    };
  });
});

describe('Zerodha fills to journal', () => {
  it('previews round trips and imports each one only once', async () => {
    const { password } = await createMember();
    const session = await signIn(app, { email: 'member@example.com', password });
    const preview = await session.agent.get('/api/kite/fills');
    expect(preview.status).toBe(200);
    expect(preview.body.candidates).toHaveLength(1);
    const [trip] = preview.body.candidates;
    expect(trip).toMatchObject({
      symbol: 'INFY',
      type: 'Long',
      quantity: 10,
      entryPrice: 1500,
      exitPrice: 1520,
      grossPnl: 200,
      alreadyInJournal: false,
    });
    expect(preview.body.open).toEqual([expect.objectContaining({ symbol: 'INFY', quantity: -5 })]);
    expect(preview.body.skipped).toEqual([expect.objectContaining({ exchange: 'MCX' })]);

    const send = (ids) =>
      session.agent.post('/api/kite/fills/import').set('X-CSRF-Token', session.csrf).send({ ids });
    const first = await send([trip.id]);
    expect(first.status).toBe(200);
    expect(first.body.added).toHaveLength(1);
    expect(first.body.added[0]).toMatchObject({ id: trip.id, symbol: 'INFY', grossPnl: 200 });
    const second = await send([trip.id]);
    expect(second.body).toMatchObject({ added: [], skipped: 1 });
    const again = await session.agent.get('/api/kite/fills');
    expect(again.body.candidates[0].alreadyInJournal).toBe(true);
    const ledger = await session.agent.get('/api/account/export');
    expect(ledger.body.trades).toHaveLength(1);
  });

  it('requires a choice and a signed-in member', async () => {
    const { password } = await createMember();
    const session = await signIn(app, { email: 'member@example.com', password });
    const empty = await session.agent
      .post('/api/kite/fills/import')
      .set('X-CSRF-Token', session.csrf)
      .send({ ids: [] });
    expect(empty.status).toBe(400);
    const anonymous = await (await import('supertest')).default(app).get('/api/kite/fills');
    expect(anonymous.status).toBe(401);
  });
});

describe('carried quantities from a Kite snapshot', () => {
  it('reads overnight positions and holdings', async () => {
    const { carriedFromSnapshot } = await import('../../services/broker/fills-journal.js');
    const carried = carriedFromSnapshot({
      positions: {
        net: [
          { exchange: 'NFO', symbol: 'NIFTY26MAYFUT', product: 'NRML', quantity: 25 },
          { exchange: 'NSE', symbol: 'INFY', product: 'MIS', quantity: 0 },
          { exchange: 'NSE', symbol: 'SBIN', product: 'CNC', quantity: -10 },
        ],
        day: [
          { exchange: 'NFO', symbol: 'NIFTY26MAYFUT', product: 'NRML', quantity: -25 },
          { exchange: 'NSE', symbol: 'INFY', product: 'MIS', quantity: 0 },
        ],
      },
      holdings: [{ exchange: 'NSE', symbol: 'SBIN', quantity: 8, t1Quantity: 2 }],
    });
    expect([...carried]).toEqual([
      ['NFO:NIFTY26MAYFUT:NRML', 50],
      ['NSE:SBIN:CNC', 10],
      ['BSE:SBIN:CNC', 10],
    ]);
  });
});
