// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { safeJson } from '../../middleware/view-helpers.js';

describe('safeJson', () => {
  it('escapes what could close or break a script block, and still parses back', () => {
    const value = { note: '</script><b>a & b</b>\u2028\u2029', list: [1, null, 'ok'] };
    const json = safeJson(value);
    expect(json).toBe(
      '{"note":"\\u003c/script\\u003e\\u003cb\\u003ea \\u0026 b\\u003c/b\\u003e\\u2028\\u2029","list":[1,null,"ok"]}',
    );
    expect(JSON.parse(json)).toEqual(value);
    expect(safeJson(undefined)).toBe('null');
  });
});
