/**
 * NSE session helpers.
 *
 * IST is derived with Intl.DateTimeFormat parts. The previous approach —
 * `new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))` —
 * round-trips a date through a human-readable string, which is not a format
 * the Date parser is required to understand and differs between engines.
 */

const IST_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hour12: false,
});

const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Wall-clock parts of an instant in IST: `date` (YYYY-MM-DD), hour, minute, second,
 * weekday (0 = Sunday) and minutesSinceMidnight.
 */
export function toIst(instant = new Date()) {
  const parts = IST_FORMATTER.formatToParts(instant);
  const lookup = (type) => parts.find((part) => part.type === type)?.value ?? '';

  // en-CA renders hour 24 for midnight; normalise it to 0.
  const hour = Number(lookup('hour')) % 24;
  const minute = Number(lookup('minute'));
  const second = Number(lookup('second'));

  return {
    date: `${lookup('year')}-${lookup('month')}-${lookup('day')}`,
    hour,
    minute,
    second,
    weekday: WEEKDAY_INDEX[lookup('weekday')] ?? 0,
    minutesSinceMidnight: hour * 60 + minute,
  };
}

/** NSE equity session: 09:15 to 15:30 IST. */
export const MARKET_OPEN_MINUTE = 9 * 60 + 15;
export const MARKET_CLOSE_MINUTE = 15 * 60 + 30;

/**
 * NSE trading holidays. This list needs a yearly update; an unknown year falls
 * back to weekends only, which is the safe direction to be wrong in — it never
 * claims the market is closed when it is open.
 */
export const NSE_HOLIDAYS = new Set([
  // 2026 (NSE equity and equity derivatives holiday circular; weekend holidays included)
  '2026-01-15', // Maharashtra municipal elections
  '2026-01-26', // Republic Day
  '2026-02-15', // Mahashivratri (Sunday)
  '2026-03-03', // Holi
  '2026-03-21', // Id-ul-Fitr (Saturday)
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id
  '2026-06-26', // Muharram
  '2026-08-15', // Independence Day (Saturday)
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-08', // Diwali Laxmi Pujan (Sunday; Muhurat trading is announced separately)
  '2026-11-10', // Diwali Balipratipada
  '2026-11-24', // Guru Nanak Jayanti
  '2026-12-25', // Christmas
]);

/**
 * NSE session state at an instant: 'open', 'closed-weekend', 'closed-holiday' or 'closed-hours'.
 * The 15:30 IST minute still counts as open; holidays come from NSE_HOLIDAYS.
 */
export function getMarketStatus(instant = new Date()) {
  const ist = toIst(instant);

  if (ist.weekday === 0 || ist.weekday === 6) return 'closed-weekend';
  if (NSE_HOLIDAYS.has(ist.date)) return 'closed-holiday';
  if (
    ist.minutesSinceMidnight < MARKET_OPEN_MINUTE ||
    ist.minutesSinceMidnight > MARKET_CLOSE_MINUTE
  ) {
    return 'closed-hours';
  }
  return 'open';
}

/** True only while getMarketStatus reports 'open'. */
export function isMarketOpen(instant = new Date()) {
  return getMarketStatus(instant) === 'open';
}

/** Status text for a getMarketStatus value; undefined for an unknown status. */
export function describeMarketStatus(status) {
  switch (status) {
    case 'open':
      return 'Market is open';
    case 'closed-weekend':
      return 'Market is closed — weekend';
    case 'closed-holiday':
      return 'Market is closed — trading holiday';
    case 'closed-hours':
      return 'Market is closed';
  }
}

/** Today's date in IST as YYYY-MM-DD, for date inputs and daily filters. */
export function todayInIst() {
  return toIst().date;
}
