/**
 * Planning report: order plans for the selected day, week or month, with sync
 * status and printable layout.
 */
import { $, h, button, select, label, render } from '../../core/dom.js';
import {
  inReportPeriod,
  instantBusinessDate,
  reportPeriod,
} from '../../../../shared/business-dates.js';
import { todayInIst } from '../../../../shared/market.js';
import { formatPlanningMoney, formatPlanningPrice } from '../../../../shared/risk-calculator.js';
import { planSyncMessage } from '../../lib/order-plans-store.js';
import { accountId, workspace, workspaceAvailable } from './shared.js';

export const planning = { periodType: 'daily' };
// The order-plan store, created at start-up by the page entry (reports.js).
export const planStoreRef = { current: null };

/**
 * Renders the printable planning report: saved order plans created in the chosen period
 * (today, this week or this month, IST) with their sizing and fee estimates.
 */
export function paintPlanning() {
  if (!planStoreRef.current) return;
  const { plans, error, syncStatus } = planStoreRef.current;
  const today = todayInIst();
  const period = reportPeriod(
    planning.periodType,
    planning.periodType === 'monthly' ? today.slice(0, 7) : today,
  );
  const filtered = plans.filter(
    (plan) => period && inReportPeriod(instantBusinessDate(plan.createdAt), period),
  );
  const generatedAt = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Kolkata',
  }).format(new Date());
  const periodLabel =
    planning.periodType === 'daily' ? 'day' : planning.periodType === 'weekly' ? 'week' : 'month';
  const periodSelect = select({ id: 'planning-period', className: 'max-w-xs' }, [
    { value: 'daily', label: 'Today', selected: planning.periodType === 'daily' },
    { value: 'weekly', label: 'This week', selected: planning.periodType === 'weekly' },
    { value: 'monthly', label: 'This month', selected: planning.periodType === 'monthly' },
  ]);
  periodSelect.addEventListener('change', () => {
    planning.periodType = periodSelect.value;
    paintPlanning();
  });
  const rows =
    accountId && !error
      ? filtered.map((plan) =>
          h(
            'tr',
            {},
            h(
              'td',
              {},
              plan.symbol,
              h('small', {}, plan.strategySnapshot?.name || 'No strategy selected'),
            ),
            h(
              'td',
              {},
              `${plan.direction === 'Long' ? 'BUY' : 'SELL'} / ${plan.estimate.quantity}`,
            ),
            h('td', {}, formatPlanningPrice(plan.inputs.entryPrice)),
            h(
              'td',
              {},
              `${formatPlanningPrice(plan.inputs.stopLoss)} / ${plan.inputs.takeProfit ? formatPlanningPrice(plan.inputs.takeProfit) : '—'}`,
            ),
            h(
              'td',
              {},
              formatPlanningMoney(plan.estimate.stopFeesPaise),
              h(
                'small',
                {},
                `Stop scenario${plan.estimate.targetFeesPaise !== null ? ` · target ${formatPlanningMoney(plan.estimate.targetFeesPaise)}` : ''}`,
              ),
            ),
          ),
        )
      : [];
  if (!accountId || error || filtered.length === 0) {
    rows.push(
      h(
        'tr',
        {},
        h(
          'td',
          { colspan: '5' },
          !accountId
            ? 'Plans are unavailable until your active account is ready.'
            : error
              ? 'Saved plans could not be loaded. This is not a verified empty report.'
              : syncStatus.state === 'synced'
                ? 'No saved plans in this period.'
                : 'Cloud plan history is not yet complete.',
        ),
      ),
    );
  }
  const rules = workspace?.rules ?? [];
  render(
    $('[data-planning]'),
    h(
      'div',
      { class: 'workspace-pagehead' },
      h(
        'div',
        {},
        h('h1', {}, 'Reports'),
        h('p', {}, 'Day, week and month exports from saved planning estimates.'),
      ),
      button('Print planning report', {
        disabled: !accountId || Boolean(error) || syncStatus.state !== 'synced',
        onclick: () => window.print(),
      }),
    ),
    h(
      'section',
      { class: 'rr-panel hide-on-print' },
      label('Reporting period', 'planning-period'),
      periodSelect,
      h(
        'p',
        { class: 'rr-muted' },
        'No execution records are connected. The printable report below contains saved plans only.',
      ),
      period
        ? h(
            'p',
            { class: 'rr-muted' },
            `${period.start} to ${period.end} · IST${planning.periodType === 'weekly' ? ' · Monday–Sunday calendar week' : ''}`,
          )
        : null,
      error ? h('p', { role: 'alert', class: 'mt-1 text-xs text-negative' }, error) : null,
      h(
        'div',
        {
          class: 'border border-line bg-surface px-4 py-3 text-sm text-muted',
          role: 'status',
          'aria-live': 'polite',
        },
        planSyncMessage(syncStatus),
        syncStatus.state === 'error'
          ? button('Retry sync', {
              variant: 'outline',
              className: 'ml-2 mt-2',
              onclick: () => planStoreRef.current.retrySync(),
            })
          : null,
      ),
    ),
    h(
      'section',
      { class: 'rr-panel printable-report', 'aria-label': 'Planning report' },
      h(
        'div',
        { class: 'rr-pair' },
        h(
          'div',
          {},
          h('p', { class: 'rr-eyebrow' }, 'Pirento Blank'),
          h('h2', {}, `Planning report · ${periodLabel}`),
        ),
        h('span', { class: 'rr-stamp' }, 'UNVERIFIED'),
      ),
      h('p', {}, `Generated ${generatedAt} IST`),
      period ? h('p', {}, `Reporting period: ${period.start} to ${period.end} · IST`) : null,
      h(
        'p',
        {},
        'Realised P&L: unavailable. Charges: estimates only. No profit/loss result can be certified from planned trades.',
      ),
      h(
        'p',
        { class: 'rr-muted' },
        `${syncStatus.state === 'synced' ? 'Plans synced to this private account.' : 'Cloud sync is incomplete; this browser may not contain all account plans.'} Rules below are the current snapshot; each saved plan retains its own assumptions.`,
      ),
      h(
        'div',
        { class: 'rr-tablewrap' },
        h(
          'table',
          { class: 'rr-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ['Instrument', 'Side / Qty', 'Entry', 'Stop / Target', 'Est. costs'].map((text) =>
                h('th', {}, text),
              ),
            ),
          ),
          h('tbody', {}, rows),
        ),
      ),
      h('h3', {}, 'Rules in effect'),
      h(
        'p',
        { class: 'rr-rules' },
        !workspaceAvailable
          ? 'Current rules are unavailable while your account data loads.'
          : rules.map((rule) => rule.rule).join('\n') || 'No trading rules saved.',
      ),
    ),
  );
}
