// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reserveAttempts } from '../../services/rate-window.js';

const { resetDatabase, startTestApp, stopTestApp } = await import('../helpers/app.js');

beforeAll(async () => {
  await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetDatabase);

describe('rate windows', () => {
  it('never lets parallel requests overshoot the limit', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => reserveAttempts([{ key: 'burst', limit: 10 }], 60_000)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results.find((result) => !result.allowed).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reserves in every bucket or in none', async () => {
    const now = Date.now();
    expect((await reserveAttempts([{ key: 'b', limit: 1 }], 60_000, now)).allowed).toBe(true);
    const blocked = await reserveAttempts(
      [
        { key: 'a', limit: 1 },
        { key: 'b', limit: 1 },
      ],
      60_000,
      now,
    );
    expect(blocked.allowed).toBe(false);
    // "a" was given back, so it still has its one attempt.
    expect((await reserveAttempts([{ key: 'a', limit: 1 }], 60_000, now)).allowed).toBe(true);
  });

  it('starts a new window after the old one ends', async () => {
    const now = Date.now();
    await reserveAttempts([{ key: 'w', limit: 1 }], 1000, now);
    expect((await reserveAttempts([{ key: 'w', limit: 1 }], 1000, now + 10)).allowed).toBe(false);
    expect((await reserveAttempts([{ key: 'w', limit: 1 }], 1000, now + 1500)).allowed).toBe(true);
  });
});
