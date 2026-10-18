/**
 * Helpers shared by the admin panel pages: page data, the authenticator notice
 * and small formatters.
 */
import { h, pageData } from '../core/dom.js';

export const data = pageData();

/** Notice shown when admin changes are blocked until the authenticator is used. */
export function mfaNotice() {
  if (data.mfaVerified) return null;
  return h(
    'p',
    { role: 'note', class: 'mb-4 border border-caution bg-caution-soft px-3 py-2 text-sm text-fg' },
    'You can look around, but saving changes here needs an authenticator. Add one in ',
    h('a', { href: '/settings', class: 'text-accent underline' }, 'Settings → Authenticator'),
    ', then sign in to the admin panel again.',
  );
}

const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
/** ₹ amount without paise, e.g. ₹1,49,900. */
export const money = (value) => rupees.format(Number(value) || 0);

/** Bytes as a short human size, e.g. 1.4 GB. */
export function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** An ISO time as a short IST date and time, or "—". */
export function when(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}
