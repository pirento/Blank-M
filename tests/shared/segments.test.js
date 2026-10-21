import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FO_CHARGES,
  chargesForSegment,
  contractDetails,
  lotProblem,
  segmentOfSymbol,
} from '../../shared/segments.js';
import { computeCharges } from '../../shared/pnl.js';
import { DEFAULT_CHARGES } from '../../shared/types.js';

describe('segments', () => {
  it('detects F&O symbols and picks segment charge rates', () => {
    expect(segmentOfSymbol('INFY', 'NSE')).toBe('EQ');
    expect(segmentOfSymbol('NIFTY26OCTFUT', 'NFO')).toBe('FUT');
    expect(segmentOfSymbol('NIFTY26OCT24500PE', 'NFO')).toBe('OPT');
    expect(segmentOfSymbol('WEIRD', 'NFO')).toBeNull();
    const settings = { charges: DEFAULT_CHARGES };
    expect(chargesForSegment(settings, 'EQ')).toBe(DEFAULT_CHARGES);
    expect(chargesForSegment(settings, 'OPT')).toBe(DEFAULT_FO_CHARGES.options);
  });

  it('charges options a flat ₹20 brokerage per order', () => {
    const charges = computeCharges(
      { type: 'Long', entryPrice: 100, exitPrice: 120, quantity: 75 },
      DEFAULT_FO_CHARGES.options,
    );
    expect(charges.brokerage).toBe(40);
    // STT 0.15% (from 1 April 2026) on the ₹9,000 sell premium.
    expect(charges.stt).toBe(13.5);
  });

  it('validates contract details and whole lots', () => {
    expect(contractDetails({ segment: 'EQ', lotSize: 75 }).values).toMatchObject({
      segment: 'EQ',
      lotSize: null,
    });
    const option = contractDetails({
      segment: 'OPT',
      lotSize: '75',
      expiry: '2026-10-27',
      strike: '24500',
      optionType: 'CE',
    });
    expect(option.errors).toEqual({});
    expect(option.values).toMatchObject({ lotSize: 75, strike: 24500, optionType: 'CE' });
    expect(contractDetails({ segment: 'OPT' }).errors).toHaveProperty('optionType');
    expect(contractDetails({ segment: 'SWAP' }).errors).toHaveProperty('segment');
    expect(lotProblem(150, 75)).toBeNull();
    expect(lotProblem(100, 75)).toMatch(/multiple of the lot size/);
  });
});
