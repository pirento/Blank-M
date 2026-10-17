import { describe, expect, it } from 'vitest';
import { normalizeSheet } from '../../shared/spreadsheet-data.js';
import { buildCandidates, guessMapping } from '../../shared/csv.js';

describe('spreadsheet imports share the validated CSV pipeline', () => {
  it('preserves decimal prices, direction and calendar dates', () => {
    const sheet = normalizeSheet('Trade book', [
      ['Date', 'Symbol', 'Type', 'Entry Price', 'Exit Price', 'Quantity'],
      [new Date('2026-10-07T00:00:00Z'), 'RELIANCE', 'Sell', '100.0123', '90.0123', '10'],
      [null, null],
    ]);
    expect(sheet.rows).toEqual([['2026-10-07', 'RELIANCE', 'Sell', '100.0123', '90.0123', '10']]);
    const result = buildCandidates(sheet.rows, guessMapping(sheet.headers));
    expect(result.errors).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      type: 'Short',
      entryPrice: 100.0123,
      exitPrice: 90.0123,
      quantity: 10,
    });
  });
  it('rejects invalid data and bounds the preview', () => {
    expect(() => normalizeSheet('x', [['Header'], [Infinity]])).toThrow('unsupported');
    expect(() => normalizeSheet('x', [['Header'], [new Date(NaN)]])).toThrow('invalid date');
    expect(() => normalizeSheet('x', [Array.from({ length: 201 }, () => 'x')])).toThrow(
      '200 columns',
    );
  });
});
