import { describe, expect, it } from 'vitest';
import {
  inReportPeriod,
  instantBusinessDate,
  reportPdfFilename,
  reportPeriod,
  reportPeriodTitle,
} from '../../shared/business-dates.js';

function validPeriod(type, key) {
  const period = reportPeriod(type, key);
  if (!period) throw new Error(`Expected a valid ${type} period for ${key}`);
  return period;
}

describe('Monday–Sunday calendar report periods', () => {
  it.each([
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
    '2026-10-10',
    '2026-10-11',
  ])('gives every anchor in the week the same inclusive range: %s', (key) => {
    expect(reportPeriod('weekly', key)).toEqual({
      type: 'weekly',
      key,
      start: '2026-10-05',
      end: '2026-10-11',
    });
  });

  it.each([
    ['2026-09-30', '2026-09-28', '2026-10-04'],
    ['2026-10-04', '2026-09-28', '2026-10-04'],
    ['2026-10-12', '2026-10-12', '2026-10-18'],
    ['2020-12-31', '2020-12-28', '2021-01-03'],
    ['2021-01-01', '2020-12-28', '2021-01-03'],
    ['2024-02-29', '2024-02-26', '2024-03-03'],
    ['2000-02-29', '2000-02-28', '2000-03-05'],
    ['1900-03-01', '1900-02-26', '1900-03-04'],
    ['2026-03-08', '2026-03-02', '2026-03-08'],
    ['2026-11-01', '2026-10-26', '2026-11-01'],
    ['0099-12-31', '0099-12-28', '0100-01-03'],
  ])('handles month, year, leap-day and DST boundaries for %s', (key, start, end) => {
    expect(reportPeriod('weekly', key)).toEqual({ type: 'weekly', key, start, end });
  });

  it.each([
    '',
    ' ',
    '\n',
    'not a date',
    '2026-10',
    '2026-W41',
    '2026-1-05',
    '2026-10-5',
    '2026/10/05',
    ' 2026-10-05',
    '2026-10-05 ',
    '2026-10-05\n',
    '2026-10-05T00:00:00Z',
    '2026-10-05T00:00:00+05:30',
    '2026-02-29',
    '1900-02-29',
    '2024-02-30',
    '2026-04-31',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '2026-01-32',
    '0000-01-01',
    '10000-01-01',
    '-000001-01-01',
  ])('rejects an invalid or non-date-only weekly key %j', (key) => {
    expect(reportPeriod('weekly', key)).toBeNull();
  });

  it.each(['0001-01-01', '0001-01-02', '0001-01-07'])(
    'supports the earliest complete Gregorian week for %s',
    (key) => {
      expect(reportPeriod('weekly', key)).toEqual({
        type: 'weekly',
        key,
        start: '0001-01-01',
        end: '0001-01-07',
      });
    },
  );

  it.each(['9999-12-20', '9999-12-21', '9999-12-26'])(
    'supports the latest complete Gregorian week for %s',
    (key) => {
      expect(reportPeriod('weekly', key)).toEqual({
        type: 'weekly',
        key,
        start: '9999-12-20',
        end: '9999-12-26',
      });
    },
  );

  it.each(['9999-12-27', '9999-12-28', '9999-12-29', '9999-12-30', '9999-12-31'])(
    'rejects %s because its complete week extends into year 10000',
    (key) => {
      expect(reportPeriod('weekly', key)).toBeNull();
      // Daily and monthly reports still support the same late-December date.
      expect(reportPeriod('daily', key)).toEqual({ type: 'daily', key, start: key, end: key });
      expect(reportPeriod('monthly', '9999-12')).toEqual({
        type: 'monthly',
        key: '9999-12',
        start: '9999-12-01',
        end: '9999-12-31',
      });
    },
  );
});

describe('weekly date membership and IST timestamp conversion', () => {
  const period = validPeriod('weekly', '2026-10-07');

  it.each([
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
    '2026-10-10',
    '2026-10-11',
  ])('includes every calendar date including Monday, Saturday and Sunday: %s', (date) => {
    expect(inReportPeriod(date, period)).toBe(true);
  });

  it.each([
    null,
    '',
    '2026-10-04',
    '2026-10-12',
    '2026-10-00',
    '2026-10-32',
    '2026-10-5',
    '2026-10-05T00:00:00Z',
  ])('excludes outside or malformed date %j', (date) => {
    expect(inReportPeriod(date, period)).toBe(false);
  });

  it('rejects absent or rejected periods', () => {
    expect(inReportPeriod('2026-10-07', null)).toBe(false);
    expect(inReportPeriod('9999-12-31', reportPeriod('weekly', '9999-12-31'))).toBe(false);
  });

  it.each([
    ['2026-10-04T18:29:59.999Z', '2026-10-04', false],
    ['2026-10-04T18:30:00Z', '2026-10-05', true],
    ['2026-10-05T00:00:00+05:30', '2026-10-05', true],
    ['2026-10-05T00:10:00+05:45', '2026-10-04', false],
    ['2026-10-04T13:30:00-05:00', '2026-10-05', true],
    ['2026-10-11T18:29:59.999Z', '2026-10-11', true],
    ['2026-10-11T23:59:59.999+05:30', '2026-10-11', true],
    ['2026-10-11T18:30:00Z', '2026-10-12', false],
  ])('assigns instant %s to the correct inclusive IST week', (timestamp, date, inside) => {
    expect(instantBusinessDate(timestamp)).toBe(date);
    expect(inReportPeriod(instantBusinessDate(timestamp), period)).toBe(inside);
  });

  it.each([
    '',
    'not a timestamp',
    '2026-10-05',
    '2026-10-05T12:00:00',
    '2026-10-05 12:00:00Z',
    '2026-10-05T12:00Z',
    '2026-02-30T00:00:00Z',
    '2026-10-05T24:00:00Z',
    '2026-10-05T12:60:00Z',
    '2026-10-05T12:00:60Z',
    '2026-10-05T12:00:00+24:00',
    '2026-10-05T12:00:00+05:60',
    '2026-10-05T12:00:00+0530',
    '2026-10-05T12:00:00Z\n',
    '0000-01-01T12:00:00Z',
    '10000-01-01T12:00:00Z',
    '0001-01-01T00:00:00+14:00',
    '9999-12-31T18:30:00Z',
  ])('excludes malformed or out-of-bounds chat timestamp %j', (timestamp) => {
    expect(instantBusinessDate(timestamp)).toBeNull();
    expect(inReportPeriod(instantBusinessDate(timestamp), period)).toBe(false);
  });

  it('includes both endpoints of a leap-day week and excludes adjacent dates', () => {
    const leapWeek = validPeriod('weekly', '2024-02-29');
    for (const date of ['2024-02-26', '2024-02-29', '2024-03-03']) {
      expect(inReportPeriod(date, leapWeek)).toBe(true);
    }
    for (const date of ['2024-02-25', '2024-03-04', '2024-02-30']) {
      expect(inReportPeriod(date, leapWeek)).toBe(false);
    }
  });
});

describe('timezone-independent report titles and PDF filenames', () => {
  it.each([
    ['daily', '2026-10-05', 'Monday, 5 October 2026', 'Trading_Report_2026-10-05.pdf'],
    ['daily', '2024-02-29', 'Thursday, 29 February 2024', 'Trading_Report_2024-02-29.pdf'],
    ['monthly', '2026-10', 'October 2026 Monthly Report', 'Trading_Report_2026-10.pdf'],
    ['monthly', '2024-02', 'February 2024 Monthly Report', 'Trading_Report_2024-02.pdf'],
    ['daily', '0001-01-01', 'Monday, 1 January 1', 'Trading_Report_0001-01-01.pdf'],
    ['monthly', '0099-12', 'December 99 Monthly Report', 'Trading_Report_0099-12.pdf'],
    ['daily', '9999-12-31', 'Friday, 31 December 9999', 'Trading_Report_9999-12-31.pdf'],
    ['monthly', '9999-12', 'December 9999 Monthly Report', 'Trading_Report_9999-12.pdf'],
  ])('preserves %s title and file conventions for %s', (type, key, title, filename) => {
    const period = validPeriod(type, key);
    expect(reportPeriodTitle(period)).toBe(title);
    expect(reportPdfFilename(period)).toBe(filename);
  });

  it.each([
    [
      '2026-10-07',
      'Weekly Report: 5 October 2026 – 11 October 2026',
      'Trading_Report_Week_2026-10-05_to_2026-10-11.pdf',
    ],
    [
      '2024-02-29',
      'Weekly Report: 26 February 2024 – 3 March 2024',
      'Trading_Report_Week_2024-02-26_to_2024-03-03.pdf',
    ],
    [
      '2021-01-01',
      'Weekly Report: 28 December 2020 – 3 January 2021',
      'Trading_Report_Week_2020-12-28_to_2021-01-03.pdf',
    ],
    [
      '0001-01-01',
      'Weekly Report: 1 January 1 – 7 January 1',
      'Trading_Report_Week_0001-01-01_to_0001-01-07.pdf',
    ],
    [
      '9999-12-26',
      'Weekly Report: 20 December 9999 – 26 December 9999',
      'Trading_Report_Week_9999-12-20_to_9999-12-26.pdf',
    ],
  ])('formats complete weekly ranges and filenames for %s', (key, title, filename) => {
    const period = validPeriod('weekly', key);
    expect(reportPeriodTitle(period)).toBe(title);
    expect(reportPdfFilename(period)).toBe(filename);
  });

  it('uses the week endpoints rather than the selected anchor in titles and filenames', () => {
    const monday = validPeriod('weekly', '2026-10-05');
    const sunday = validPeriod('weekly', '2026-10-11');
    expect(monday.key).not.toBe(sunday.key);
    expect(reportPeriodTitle(monday)).toBe(reportPeriodTitle(sunday));
    expect(reportPdfFilename(monday)).toBe(reportPdfFilename(sunday));
  });
});

describe('runtime report kind validation', () => {
  it.each(['yearly', 'week', '', 'MONTHLY', null, undefined])(
    'rejects unsupported runtime report kind %j rather than falling through to monthly',
    (type) => {
      expect(reportPeriod(type, '2026-10')).toBeNull();
    },
  );
});
