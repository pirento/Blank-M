/**
 * Today against the member's risk limits (Settings → Risk limits): net P&L
 * versus the daily loss limit, trades versus the per-day limit and the month
 * versus its goal. Hidden when no limit is set.
 */
import { signedCurrency as signed } from '../../core/format.js';
import { t } from '../../core/i18n.js';
import { $, h, cn, formatCurrency, render } from '../../core/dom.js';
import { riskStatus, toRiskLimits } from '../../../../shared/risk-limits.js';
import { todayInIst } from '../../../../shared/market.js';
import { settings, trades } from './shared.js';

function meter(label, value, share, tone) {
  const width = `${Math.min(100, Math.max(0, Math.round(share * 100)))}%`;
  return h(
    'div',
    { class: 'space-y-1' },
    h(
      'div',
      { class: 'flex items-baseline justify-between gap-2 text-sm' },
      h('span', { class: 'text-muted' }, label),
      h('span', { class: 'tnum font-semibold text-fg' }, value),
    ),
    h(
      'div',
      {
        class: 'h-1.5 overflow-hidden rounded-full bg-line',
        role: 'meter',
        'aria-label': label,
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(Math.round(share * 100)),
      },
      h('div', { class: cn('h-full rounded-full', tone), style: `width:${width}` }),
    ),
  );
}

/**
 * Renders today's risk-limit meters (daily loss, trade count, monthly goal) for the limits
 * that are set, with an alert when a limit has paused trading. Empty when no limits exist.
 */
export function paintRisk() {
  const root = $('[data-risk-today]');
  if (!root) return;
  const limits = toRiskLimits(settings.riskLimits);
  if (Object.values(limits).every((value) => value === null)) {
    render(root);
    return;
  }
  const status = riskStatus(trades, limits, todayInIst());
  const parts = [];
  if (limits.dailyLossLimit !== null) {
    parts.push(
      meter(
        `Today ${signed(status.todayPnl)} of −${formatCurrency(limits.dailyLossLimit)} loss limit`,
        `${Math.round((status.lossUsed ?? 0) * 100)}%`,
        status.lossUsed ?? 0,
        status.dailyLossHit ? 'bg-negative' : 'bg-caution',
      ),
    );
  }
  if (limits.maxTradesPerDay !== null) {
    parts.push(
      meter(
        'Trades today',
        `${status.todayTrades} / ${limits.maxTradesPerDay}`,
        status.todayTrades / limits.maxTradesPerDay,
        status.maxTradesHit ? 'bg-negative' : 'bg-accent',
      ),
    );
  }
  if (limits.monthlyProfitGoal !== null) {
    parts.push(
      meter(
        `This month ${signed(status.monthPnl)} of ${formatCurrency(limits.monthlyProfitGoal)} goal`,
        `${Math.round(Math.max(0, status.goalProgress ?? 0) * 100)}%`,
        Math.max(0, status.goalProgress ?? 0),
        'bg-positive',
      ),
    );
  }
  render(
    root,
    h(
      'section',
      {
        'aria-label': t('Risk limits today'),
        class: cn(
          'space-y-3 rounded-card border p-4',
          status.blocked ? 'border-negative bg-negative-soft' : 'border-line bg-surface',
        ),
      },
      status.blocked
        ? h(
            'p',
            { role: 'alert', class: 'text-sm font-semibold text-negative' },
            `${status.reasons.join(' ')} Stop for today — live orders are paused.`,
          )
        : null,
      h('div', { class: 'grid grid-cols-1 gap-4 md:grid-cols-3' }, parts),
    ),
  );
}
