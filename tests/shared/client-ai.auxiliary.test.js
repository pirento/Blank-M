import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestJournalSearch,
  requestMaterialAnalysis,
  requestRuleDraft,
  requestTradeReview,
  requestTranscription,
} from '../../public/js/lib/ai.js';

const file = new File(['synthetic audio'], 'voice.webm', { type: 'audio/webm' });
const uploaded = { audioPath: 'owner-a/voice.webm', filename: 'voice.webm', mime: 'audio/webm' };
let fetchMock;

function route(handlers) {
  fetchMock = vi.fn(async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  route({
    'POST /api/uploads/voice-notes': async () => Response.json(uploaded, { status: 201 }),
    'POST /api/ai/transcribe': async () => Response.json({ transcript: 'Completed transcript' }),
    'DELETE /api/uploads/voice-notes': async () => Response.json({ ok: true }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('auxiliary request cancellation', () => {
  const operations = [
    {
      name: 'rule draft',
      run: (signal) =>
        requestRuleDraft(
          { section: 'Risk', definition: 'Private definition', rule: 'Private rule' },
          signal,
        ),
    },
    { name: 'journal search', run: (signal) => requestJournalSearch('Private question', signal) },
    {
      name: 'material analysis',
      run: (signal) =>
        requestMaterialAnalysis({ attachmentPath: 'owner-a/file.pdf', kind: 'statement' }, signal),
    },
    {
      name: 'trade review',
      run: (signal) => requestTradeReview({ trades: '[]', rules: 'Private rules' }, signal),
    },
  ];
  it.each(operations)('does not dispatch $name once its caller has left', async ({ run }) => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not upload audio when the caller has already left', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(requestTranscription(file, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cleans up an uploaded voice note and never transcribes it after cancellation', async () => {
    const controller = new AbortController();
    route({
      'POST /api/uploads/voice-notes': async () => {
        controller.abort();
        return Response.json(uploaded, { status: 201 });
      },
      'DELETE /api/uploads/voice-notes': async () => Response.json({ ok: true }),
    });
    await expect(requestTranscription(file, controller.signal)).rejects.toBeTruthy();
    const calls = fetchMock.mock.calls.map(([url, init]) => `${init.method} ${url}`);
    expect(calls).not.toContain('POST /api/ai/transcribe');
  });

  it('removes the temporary upload after transcription', async () => {
    await expect(requestTranscription(file)).resolves.toBe('Completed transcript');
    const cleanup = fetchMock.mock.calls.find(([, init]) => init.method === 'DELETE');
    expect(JSON.parse(cleanup[1].body)).toEqual({ path: uploaded.audioPath });
  });

  it('does not mask a completed transcript when client cleanup fails', async () => {
    route({
      'POST /api/uploads/voice-notes': async () => Response.json(uploaded, { status: 201 }),
      'POST /api/ai/transcribe': async () => Response.json({ transcript: 'Completed transcript' }),
      'DELETE /api/uploads/voice-notes': async () => {
        throw new Error('Synthetic cleanup transport failure');
      },
    });
    await expect(requestTranscription(file)).resolves.toBe('Completed transcript');
  });
});
