/**
 * P&L calendar: the last three months, each day coloured by its net P&L
 * (green for gains, red for losses, stronger for larger amounts).
 */
import { signedCurrency as signed, pnlTone as tone } from '../core/format.js';
import { h, cn } from '../core/dom.js';
import { todayInIst } from '../../../shared/market.js';
import { calendarMonths } from '../../../shared/insights.js';

/** The calendar grid element for the given trades, ending at today's month in IST. */
export function pnlCalendar(trades) {
  const months = calendarMonths(trades, 3, new Date(`${todayInIst()}T12:00:00Z`));
  const largest = Math.max(
    1,
    ...months.flatMap((month) => month.weeks.flat()).map((cell) => Math.abs(cell?.pnl ?? 0)),
  );
  const cellView = (cell) => {
    if (!cell) return h('div', { class: 'aspect-square' });
    const strength = cell.count ? 0.15 + 0.85 * (Math.abs(cell.pnl) / largest) : 0;
    const color = cell.pnl >= 0 ? 'positive' : 'negative';
    const text = cell.count
      ? `${cell.date}: ${signed(cell.pnl)} from ${cell.count} ${cell.count === 1 ? 'trade' : 'trades'}`
      : `${cell.date}: no trades`;
    return h(
      'div',
      {
        class: cn(
          'flex aspect-square items-center justify-center rounded-[4px] text-[10px]',
          cell.count ? 'text-fg' : 'border border-line text-subtle',
        ),
        // Mixed into the background at up to 45%, so the text on top keeps its contrast in both themes.
        style: cell.count
          ? {
              backgroundColor: `color-mix(in srgb, var(--color-${color}) ${Math.round(strength * 45)}%, transparent)`,
            }
          : {},
        title: text,
        role: 'img',
        'aria-label': text,
      },
      String(Number(cell.date.slice(8))),
    );
  };
  return h(
    'div',
    { class: 'grid gap-6 md:grid-cols-3' },
    months.map((month) =>
      h(
        'div',
        { class: 'space-y-2' },
        h(
          'div',
          { class: 'flex items-baseline justify-between text-sm' },
          h('span', { class: 'font-medium text-fg' }, month.label),
          h('span', { class: cn('tnum text-xs', tone(month.netPnl)) }, signed(month.netPnl)),
        ),
        h(
          'div',
          { class: 'grid grid-cols-7 gap-1 text-center text-[10px] text-subtle' },
          ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day) => h('span', {}, day)),
        ),
        h('div', { class: 'grid grid-cols-7 gap-1' }, month.weeks.flat().map(cellView)),
      ),
    ),
  );
}
