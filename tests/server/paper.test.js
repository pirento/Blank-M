// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const market = vi.hoisted(() => ({ prices: {} }));
vi.mock('../../services/market/index.js', async (original) => ({
  ...(await original()),
  getQuote: async (symbol) => {
    if (!(symbol in market.prices)) throw new Error('no quote');
    return { price: market.prices[symbol] };
  },
}));

const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');
const { OrderPlanRecord } = await import('../../models/index.js');
const supertest = (await import('supertest')).default;

const SECRET = 'x'.repeat(40);
let app;
beforeAll(async () => {
  process.env.CRON_SECRET = SECRET;
  app = await startTestApp();
});
afterAll(async () => {
  delete process.env.CRON_SECRET;
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  market.prices = { INFY: 1500, TCS: 4000 };
});

async function member() {
  const { password, user } = await createMember();
  const session = await signIn(app, { email: 'member@example.com', password });
  const send = (method, path, body) =>
    session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body);
  return { ...session, send, userId: user._id };
}

describe('paper trading', () => {
  it('enters at the live price and closes at the stop on the next check', async () => {
    const { send } = await member();
    const started = await send('post', '/api/paper', {
      symbol: 'infy',
      direction: 'Long',
      quantity: 10,
      stopLoss: 1480,
      takeProfit: 1550,
    });
    expect(started.status).toBe(201);
    expect(started.body.trade).toMatchObject({ symbol: 'INFY', entryPrice: 1500, status: 'open' });

    market.prices.INFY = 1510;
    let check = await send('post', '/api/paper/refresh');
    expect(check.body.closedNow).toBe(0);
    expect(check.body.open[0]).toMatchObject({ lastPrice: 1510, openPnl: 100 });

    market.prices.INFY = 1475;
    check = await send('post', '/api/paper/refresh');
    expect(check.body.closedNow).toBe(1);
    expect(check.body.closed[0]).toMatchObject({
      exitPrice: 1475,
      exitReason: 'stop',
      grossPnl: -250,
    });
    expect(check.body.closed[0].pnl).toBeLessThan(-250);
    expect(check.body.summary).toMatchObject({ totalTrades: 1, losses: 1 });
  });

  it('rejects a stop or target already reached and closes manually', async () => {
    const { send } = await member();
    const bad = await send('post', '/api/paper', {
      symbol: 'TCS',
      direction: 'Short',
      quantity: 1,
      stopLoss: 3990,
    });
    expect(bad.status).toBe(409);
    const { trade } = (
      await send('post', '/api/paper', { symbol: 'TCS', direction: 'Short', quantity: 2 })
    ).body;
    market.prices.TCS = 3950;
    const closed = await send('post', `/api/paper/${trade.id}/close`);
    expect(closed.body.trade).toMatchObject({ exitReason: 'manual', grossPnl: 100 });
    expect((await send('post', `/api/paper/${trade.id}/close`)).status).toBe(409);
    expect((await send('delete', `/api/paper/${trade.id}`)).status).toBe(200);
  });

  it('starts from a synced plan and is closed by the scheduled check', async () => {
    const { send, userId } = await member();
    await OrderPlanRecord.create({
      userId,
      recordKey: 'plan:plan-1',
      recordKind: 'plan',
      record: {
        symbol: 'INFY',
        direction: 'Long',
        inputs: { entryPrice: '1500', stopLoss: '1450', takeProfit: '1520' },
        estimate: { quantity: 5 },
      },
      serverRevision: 1,
    });
    const started = await send('post', '/api/paper', { planId: 'plan-1' });
    expect(started.body.trade).toMatchObject({ planId: 'plan-1', quantity: 5, takeProfit: 1520 });
    expect((await send('post', '/api/paper', { planId: 'missing' })).status).toBe(409);

    market.prices.INFY = 1525;
    const denied = await supertest(app).post('/api/maintenance/price-checks');
    expect(denied.status).toBe(401);
    const run = await supertest(app)
      .post('/api/maintenance/price-checks')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(run.status).toBe(200);
    expect(run.body.paper).toMatchObject({ checked: 1, closed: 1 });
    // A second run while the first one's window is open does nothing.
    const overlap = await supertest(app)
      .post('/api/maintenance/price-checks')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(overlap.body).toMatchObject({ skipped: true });
    expect(overlap.body.paper).toBeUndefined();
    const list = await send('get', '/api/paper');
    expect(list.body.closed[0]).toMatchObject({ exitReason: 'target', exitPrice: 1525 });
  });
});
