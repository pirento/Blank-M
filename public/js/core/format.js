/**
 * Small display helpers shared by pages that show P&L.
 */
import { formatCurrency } from './dom.js';

/** "+₹1,200.00" / "-₹350.00"; "—" when there is no value. */
export function signedCurrency(value) {
  if (value === null || value === undefined) return '—';
  return `${value >= 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`;
}

/** Text colour class for a P&L amount. */
export function pnlTone(value) {
  return value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : 'text-muted';
}
