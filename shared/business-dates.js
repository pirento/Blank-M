/** The app's date-only format supports Gregorian years 0001 through 9999. */
export function isBusinessDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === '0000') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** True for a valid YYYY-MM month key. */
export function isBusinessMonth(value) {
  return /^\d{4}-\d{2}$/.test(value) && isBusinessDate(`${value}-01`);
}

/** Timestamped chat is an instant; never apply this conversion to Trade.date. */
export function instantBusinessDate(timestamp) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp))
    return null;
  if (!isBusinessDate(timestamp.slice(0, 10))) return null;
  if (
    Number(timestamp.slice(11, 13)) > 23 ||
    Number(timestamp.slice(14, 16)) > 59 ||
    Number(timestamp.slice(17, 19)) > 59
  )
    return null;
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) return null;
  // IST business dates use UTC+05:30, including the supported historical bounds.
  const date = new Date(instant.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return isBusinessDate(date) ? date : null;
}

/**
 * Inclusive `{ type, key, start, end }` dates for a 'daily' (YYYY-MM-DD), 'weekly' (any date in
 * its Monday–Sunday week) or 'monthly' (YYYY-MM) report key; null for an invalid key or type.
 */
export function reportPeriod(type, key) {
  if (type === 'daily') return isBusinessDate(key) ? { type, key, start: key, end: key } : null;
  if (type === 'weekly') {
    if (!isBusinessDate(key)) return null;
    // The key is an IST calendar date, not an instant or a market-session date.
    // UTC arithmetic keeps calendar weeks independent of the host timezone and DST.
    const first = new Date(`${key}T00:00:00Z`);
    first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
    const last = new Date(first);
    last.setUTCDate(last.getUTCDate() + 6);
    if (first.getUTCFullYear() < 1 || last.getUTCFullYear() > 9999) return null;
    return {
      type,
      key,
      start: first.toISOString().slice(0, 10),
      end: last.toISOString().slice(0, 10),
    };
  }
  if (type !== 'monthly' || !isBusinessMonth(key)) return null;
  const start = `${key}-01`;
  const last = new Date(`${start}T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return { type, key, start, end: `${key}-${String(last.getUTCDate()).padStart(2, '0')}` };
}

function formatReportDate(date, options) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    ...options,
    timeZone: 'UTC',
  });
}

/** Titles use date-only values without shifting them into the host's timezone. */
export function reportPeriodTitle(period) {
  const dateOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  if (period.type === 'daily') {
    return formatReportDate(period.start, { ...dateOptions, weekday: 'long' });
  }
  if (period.type === 'weekly') {
    return `Weekly Report: ${formatReportDate(period.start, dateOptions)} – ${formatReportDate(period.end, dateOptions)}`;
  }
  return `${formatReportDate(period.start, { year: 'numeric', month: 'long' })} Monthly Report`;
}

/** Download name, e.g. Trading_Report_2026-05.pdf or Trading_Report_Week_<start>_to_<end>.pdf. */
export function reportPdfFilename(period) {
  const suffix = period.type === 'weekly' ? `Week_${period.start}_to_${period.end}` : period.key;
  return `Trading_Report_${suffix}.pdf`;
}

/** True when a valid YYYY-MM-DD date falls within the period's inclusive start and end. */
export function inReportPeriod(date, period) {
  return Boolean(
    date && period && isBusinessDate(date) && date >= period.start && date <= period.end,
  );
}
