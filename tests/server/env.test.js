// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';

const previous = process.env.TRUST_PROXY;
afterEach(() => {
  if (previous === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = previous;
});

describe('TRUST_PROXY', () => {
  it('reads true as one proxy hop and a number as that many', () => {
    const hops = (value) => {
      process.env.TRUST_PROXY = value;
      return env.trustProxy;
    };
    expect([hops('true'), hops('1'), hops('2'), hops(' 3 ')]).toEqual([1, 1, 2, 3]);
    expect([hops('false'), hops(''), hops('0'), hops('yes')]).toEqual([0, 0, 0, 0]);
  });
});
