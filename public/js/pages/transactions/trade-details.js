/** The small details line under a ledger row's symbol. */
import { h } from '../../core/dom.js';

/** Setup tags, mistakes and emotion under the symbol (nothing when none were recorded). */
export function tradeDetails(trade) {
  const contract =
    trade.segment === 'FUT' || trade.segment === 'OPT'
      ? [
          trade.segment === 'FUT'
            ? 'FUT'
            : `${trade.optionType ?? 'OPT'} ${trade.strike ?? ''}`.trim(),
          trade.expiry && `exp ${trade.expiry}`,
          trade.lotSize && `${trade.quantity / trade.lotSize} × ${trade.lotSize}`,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;
  const timing =
    trade.entryTime || trade.exitTime ? `${trade.entryTime ?? '?'}–${trade.exitTime ?? '?'}` : null;
  const parts = [
    contract ? h('span', { class: 'text-fg' }, contract) : null,
    timing ? h('span', { class: 'text-muted' }, timing) : null,
    trade.stopLoss ? h('span', { class: 'text-muted' }, `SL ${trade.stopLoss}`) : null,
    trade.exitLegs?.length
      ? h('span', { class: 'text-muted' }, `${trade.exitLegs.length} exits`)
      : null,
    ...(trade.setupTags ?? []).map((tag) => h('span', { class: 'text-accent' }, tag)),
    ...(trade.mistakeTags ?? []).map((tag) => h('span', { class: 'text-negative' }, tag)),
    trade.emotion ? h('span', { class: 'text-muted' }, trade.emotion) : null,
  ].filter(Boolean);
  return parts.length
    ? h('div', { class: 'mt-1 flex max-w-56 flex-wrap gap-x-2 text-[11px] font-normal' }, parts)
    : null;
}
