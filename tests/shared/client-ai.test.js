import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CHAT_HISTORY_MESSAGES } from '../../shared/ai-schemas.js';

const mocks = vi.hoisted(() => ({ session: vi.fn() }));
import { AiRequestError, recentChatHistory, requestChat } from '../../public/js/lib/ai.js';

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const delta = frame({ type: 'delta', text: 'Hello' });
const done = frame({ type: 'done' });
function respond(chunks, close = true) {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (close) controller.close();
    },
    cancel,
  });
  const response = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  return { cancel, body };
}
const options = () => ({ history: [], message: 'Question' });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ data: { session: { access_token: 'unit-test-token' } } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('requestChat SSE completion', () => {
  it('returns text only after done and releases the reader without waiting for EOF', async () => {
    const { cancel, body } = respond([delta, done], false);
    const onDelta = vi.fn();
    await expect(requestChat({ ...options(), onDelta })).resolves.toBe('Hello');
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('Hello');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
  it('handles split frames, CRLF and cumulative deltas', async () => {
    const raw = (delta + frame({ type: 'delta', text: ' world' }) + done).replaceAll('\n', '\r\n');
    respond([...raw]);
    const onDelta = vi.fn();
    await expect(requestChat({ ...options(), onDelta })).resolves.toBe('Hello world');
    expect(onDelta.mock.calls).toEqual([['Hello'], ['Hello world']]);
  });
  it('decodes a Unicode character split across bytes', async () => {
    const bytes = new TextEncoder().encode(frame({ type: 'delta', text: '₹' }) + done);
    const body = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    await expect(requestChat(options())).resolves.toBe('₹');
  });
  it.each([
    ['empty stream', ''],
    ['partial answer', delta],
    ['truncated JSON', delta + 'data: {"type":"do'],
    ['undelimited done', delta + 'data: {"type":"done"}'],
  ])('rejects %s without treating EOF as completion', async (_label, stream) => {
    const { body } = respond([stream]);
    await expect(requestChat(options())).rejects.toMatchObject({ code: 'incomplete', status: 502 });
    expect(body.locked).toBe(false);
  });
  it.each(['failed', 'incomplete'])(
    'rejects a server %s event after partial text',
    async (code) => {
      const { cancel } = respond(
        [delta, frame({ type: 'error', code, error: `Response ${code}` })],
        false,
      );
      await expect(requestChat(options())).rejects.toMatchObject({
        code,
        message: `Response ${code}`,
      });
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects an error event even if a done frame follows it', async () => {
    respond([delta + frame({ type: 'error' }) + done]);
    await expect(requestChat(options())).rejects.toBeInstanceOf(AiRequestError);
  });
  it.each([
    'data: {bad json}\n\n',
    frame({ type: 'delta', text: 3 }),
    frame({ type: 'unknown' }),
    frame({ type: 'response.failed' }),
    frame({ type: 'response.incomplete' }),
  ])('rejects malformed/unrecognized events (%s)', async (invalid) => {
    respond([delta + invalid + done]);
    await expect(requestChat(options())).rejects.toThrow(/invalid stream/);
  });
  it.each([done, frame({ type: 'delta', text: '  ' }) + done])(
    'does not save an empty completed answer (%s)',
    async (raw) => {
      respond([raw]);
      await expect(requestChat(options())).rejects.toMatchObject({ code: 'incomplete' });
    },
  );
  it('ignores heartbeat comments', async () => {
    respond([': heartbeat\n\n', delta, done]);
    await expect(requestChat(options())).resolves.toBe('Hello');
  });
  it('rejects additional events in the same completed frame batch', async () => {
    respond([delta + done + frame({ type: 'error' })]);
    await expect(requestChat(options())).rejects.toThrow(/invalid stream/);
  });
  it('turns a reader failure into an incomplete-response error', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('Connection reset'));
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    await expect(requestChat(options())).rejects.toMatchObject({ code: 'incomplete' });
    expect(body.locked).toBe(false);
  });
  it('reports HTTP failures without parsing them as SSE', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Limit reached' }), { status: 429 }),
        ),
    );
    await expect(requestChat(options())).rejects.toMatchObject({
      status: 429,
      message: 'Limit reached',
    });
  });
});

describe('requestChat cancellation and timeout', () => {
  it('does not fetch when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    respond([]);
    await expect(requestChat({ ...options(), signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
      status: 499,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels while waiting for headers without calling it a timeout', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init) => {
        controller.abort();
        return Promise.reject(init.signal.reason);
      }),
    );
    await expect(requestChat({ ...options(), signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
      status: 499,
    });
  });
  it('discards partial text on user abort, releases the reader and removes its listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { body, cancel } = respond([delta], false);
    let received;
    const arrived = new Promise((resolve) => {
      received = resolve;
    });
    const result = requestChat({ ...options(), signal: controller.signal, onDelta: received });
    const rejection = expect(result).rejects.toMatchObject({ code: 'cancelled', status: 499 });
    await arrived;
    controller.abort();
    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it('labels a deadline after partial output as timeout and clears the timer', async () => {
    vi.useFakeTimers();
    const { body, cancel } = respond([delta], false);
    let received;
    const arrived = new Promise((resolve) => {
      received = resolve;
    });
    const result = requestChat({ ...options(), onDelta: received });
    const rejection = expect(result).rejects.toMatchObject({ code: 'timeout', status: 504 });
    await arrived;
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('chat context cap', () => {
  it('sends only the latest 100 of 250 messages, in original order, without mutation', async () => {
    const history = Array.from({ length: 250 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      text: `message-${i}`,
    }));
    const original = structuredClone(history);
    respond([delta + done]);
    await requestChat({ ...options(), history });
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(sent.history).toEqual(history.slice(-MAX_CHAT_HISTORY_MESSAGES));
    expect(sent.history).toHaveLength(100);
    expect(sent.history[0].text).toBe('message-150');
    expect(sent.history.at(-1).text).toBe('message-249');
    expect(history).toEqual(original);
    expect(recentChatHistory(history)).not.toBe(history);
  });
});
