// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const kite = vi.hoisted(() => ({ available: true }));
vi.mock('../../services/market/kite/market-data.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    instrumentToken: async (symbol) => ({ INFY: 408065, TCS: 2953217 })[symbol] ?? null,
    kiteProvider: { ...actual.kiteProvider, isAvailable: async () => kite.available },
  };
});
vi.mock('../../services/market/kite/connection.js', async (original) => ({
  ...(await original()),
  activeConnection: async () => ({ accessToken: 'access-token' }),
}));

/** Stand-in for Kite's socket: records what is sent and lets the test push messages. */
const sockets = [];
class FakeWebSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    sockets.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.emit('open', {});
    }, 0);
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type, event) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
  send(message) {
    this.sent.push(JSON.parse(message));
  }
  close() {
    this.readyState = 3;
    this.closed = true;
  }
}

const { parseTicks } = await import('../../services/market/kite/ticker.js');
const { createMember, resetDatabase, signIn, startTestApp, stopTestApp } =
  await import('../helpers/app.js');

/** One Kite LTP message: [count][length=8][token][price in paise] per tick. */
function ltpMessage(ticks) {
  const buffer = new ArrayBuffer(2 + ticks.length * 10);
  const view = new DataView(buffer);
  view.setInt16(0, ticks.length);
  ticks.forEach(([token, paise], index) => {
    const offset = 2 + index * 10;
    view.setInt16(offset, 8);
    view.setUint32(offset + 2, token);
    view.setInt32(offset + 6, paise);
  });
  return buffer;
}

let app;
const realWebSocket = globalThis.WebSocket;
beforeAll(async () => {
  process.env.KITE_API_KEY = 'test-key';
  globalThis.WebSocket = FakeWebSocket;
  app = await startTestApp();
});
afterAll(async () => {
  globalThis.WebSocket = realWebSocket;
  delete process.env.KITE_API_KEY;
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  sockets.length = 0;
  kite.available = true;
});

describe('Kite tick parsing', () => {
  it('reads LTP packets and ignores heartbeats and truncated data', () => {
    expect(
      parseTicks(
        ltpMessage([
          [408065, 150025],
          [2953217, 412000],
        ]),
      ),
    ).toEqual([
      { token: 408065, price: 1500.25 },
      { token: 2953217, price: 4120 },
    ]);
    expect(parseTicks(new ArrayBuffer(1))).toEqual([]);
    expect(parseTicks(ltpMessage([[408065, 150025]]).slice(0, 7))).toEqual([]);
  });
});

describe('live quote stream', () => {
  it('streams Zerodha prices to the page over Server-Sent Events', async () => {
    const { password } = await createMember();
    const session = await signIn(app, { email: 'member@example.com', password });
    let text = '';
    const response = await session.agent
      .get('/api/quotes/stream?symbols=INFY,TCS')
      .buffer(false)
      .parse((res, done) => {
        res.on('data', (chunk) => {
          text += chunk;
          if (text.includes(': live') || text.includes('retry:')) {
            // Connected: wait for the socket to open, then push a tick.
            setTimeout(
              () => sockets[0].emit('message', { data: ltpMessage([[408065, 150025]]) }),
              20,
            );
          }
          if (text.includes('data:')) {
            res.destroy();
            done(null, text);
          }
        });
      });
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    // Zerodha ticks carry the time they were sent as "at".
    expect(text).toMatch(/data: \{"symbol":"INFY","price":1500.25,"at":\d+\}/);
    expect(sockets[0].url).toBe('wss://ws.kite.trade?api_key=test-key&access_token=access-token');
    expect(sockets[0].sent).toEqual([
      { a: 'subscribe', v: [408065, 2953217] },
      { a: 'mode', v: ['ltp', [408065, 2953217]] },
    ]);
    // The page left: the member's Kite socket closes.
    await vi.waitFor(() => expect(sockets[0].closed).toBe(true));
  });

  it('says "unavailable" without Kite live data, and needs a valid symbol and sign-in', async () => {
    const { password } = await createMember();
    const session = await signIn(app, { email: 'member@example.com', password });
    kite.available = false;
    const unavailable = await session.agent.get('/api/quotes/stream?symbols=INFY');
    expect(unavailable.status).toBe(200);
    expect(unavailable.text).toBe('event: unavailable\ndata: {}\n\n');
    expect((await session.agent.get('/api/quotes/stream?symbols=<x>')).status).toBe(400);
    expect(sockets).toEqual([]);
    const supertest = (await import('supertest')).default;
    expect((await supertest(app).get('/api/quotes/stream?symbols=INFY')).status).toBe(401);
  });
});
