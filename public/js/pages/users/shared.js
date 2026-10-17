/**
 * Users page state and small formatting helpers.
 */
import { pageData, formatIstDateTime } from '../../core/dom.js';

/** Formats a timestamp as a medium date and short time in IST, or `—` when empty. */
export const readableDate = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Kolkata',
      }).format(new Date(value))
    : '—';
export const ist = formatIstDateTime;

export const emailEnabled = Boolean(pageData()?.health?.email);

export const state = {
  users: [],
  loading: true,
  busy: null,
  loadError: null,
  method: 'manual',
  private: {
    records: [],
    loading: true,
    busy: false,
    error: '',
    listError: '',
    created: null,
    copied: false,
  },
};
