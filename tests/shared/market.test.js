import { describe, expect, it } from 'vitest';
import { getMarketStatus, isMarketOpen, toIst } from '../../shared/market.js';

/** Helper: build a UTC instant. IST is UTC+05:30. */
function utc(iso) {
  return new Date(iso);
}

describe('toIst', () => {
  it('shifts a UTC instant into IST', () => {
    // 04:00 UTC is 09:30 IST on the same day.
    const ist = toIst(utc('2026-08-10T04:00:00Z'));
    expect(ist.date).toBe('2026-08-10');
    expect(ist.hour).toBe(9);
    expect(ist.minute).toBe(30);
    expect(ist.minutesSinceMidnight).toBe(570);
  });

  it('rolls the IST date forward across the UTC evening', () => {
    // 20:00 UTC on the 9th is 01:30 IST on the 10th.
    const ist = toIst(utc('2026-08-09T20:00:00Z'));
    expect(ist.date).toBe('2026-08-10');
    expect(ist.hour).toBe(1);
  });

  it('normalises IST midnight to hour zero rather than 24', () => {
    // 18:30 UTC is exactly 00:00 IST the next day.
    const ist = toIst(utc('2026-08-09T18:30:00Z'));
    expect(ist.hour).toBe(0);
    expect(ist.minutesSinceMidnight).toBe(0);
    expect(ist.date).toBe('2026-08-10');
  });
});

describe('getMarketStatus', () => {
  it('is open during the session on a weekday', () => {
    // 2026-08-10 is a Monday. 05:00 UTC = 10:30 IST.
    expect(getMarketStatus(utc('2026-08-10T05:00:00Z'))).toBe('open');
    expect(isMarketOpen(utc('2026-08-10T05:00:00Z'))).toBe(true);
  });

  it('is closed before the open and after the close', () => {
    // 03:00 UTC = 08:30 IST, before 09:15.
    expect(getMarketStatus(utc('2026-08-10T03:00:00Z'))).toBe('closed-hours');
    // 11:00 UTC = 16:30 IST, after 15:30.
    expect(getMarketStatus(utc('2026-08-10T11:00:00Z'))).toBe('closed-hours');
  });

  it('is open exactly at the boundaries', () => {
    // 03:45 UTC = 09:15 IST, 10:00 UTC = 15:30 IST.
    expect(getMarketStatus(utc('2026-08-10T03:45:00Z'))).toBe('open');
    expect(getMarketStatus(utc('2026-08-10T10:00:00Z'))).toBe('open');
  });

  it('follows the 2026 NSE holiday list', () => {
    // 9 Nov 2026 is a trading day; 10 Nov (Diwali Balipratipada) and 26 Mar (Ram Navami) are not.
    expect(getMarketStatus(utc('2026-11-09T05:00:00Z'))).toBe('open');
    expect(getMarketStatus(utc('2026-11-10T05:00:00Z'))).toBe('closed-holiday');
    expect(getMarketStatus(utc('2026-03-26T05:00:00Z'))).toBe('closed-holiday');
    expect(getMarketStatus(utc('2026-03-04T05:00:00Z'))).toBe('open');
  });

  it('is closed at the weekend', () => {
    // 2026-08-08 is a Saturday, 2026-08-09 a Sunday.
    expect(getMarketStatus(utc('2026-08-08T05:00:00Z'))).toBe('closed-weekend');
    expect(getMarketStatus(utc('2026-08-09T05:00:00Z'))).toBe('closed-weekend');
  });

  it('is closed on a listed trading holiday', () => {
    // 2026-08-15 (Independence Day) falls on a Saturday, so use Republic Day,
    // 2026-01-26, which is a Monday.
    expect(getMarketStatus(utc('2026-01-26T05:00:00Z'))).toBe('closed-holiday');
  });
});
