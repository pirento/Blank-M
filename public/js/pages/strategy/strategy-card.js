/**
 * One strategy in the library: stage picker, measured performance of the
 * trades logged against it, and its written rules, improvements and notes.
 */
import {
  h,
  icon,
  button,
  label,
  select,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  formatCurrency,
} from '../../core/dom.js';
import { api } from '../../core/api.js';
import { notify, notifyError } from '../../core/toast.js';
import { summarisePerformance } from '../../../../shared/pnl.js';
import { STRATEGY_STAGES, stageLabel } from '../../../../shared/strategy-stages.js';

/** Stage picker for one strategy; each change is saved with its date. */
function stageControl(strategy, { available, onChanged }) {
  const selectId = `stage-${strategy.id.slice(0, 8)}`;
  const picker = select(
    { id: selectId, className: 'h-9 w-auto', disabled: !available },
    STRATEGY_STAGES.map((stage) => ({
      value: stage.value,
      label: stage.label,
      selected: stage.value === strategy.stage,
    })),
  );
  picker.addEventListener('change', async () => {
    picker.disabled = true;
    try {
      const result = await api(`/api/strategies/${encodeURIComponent(strategy.id)}/stage`, {
        method: 'PUT',
        body: { stage: picker.value },
      });
      notify(`${strategy.name} is now ${stageLabel(picker.value)}.`, 'success');
      onChanged(result.strategy);
    } catch (error) {
      picker.value = strategy.stage;
      picker.disabled = false;
      notifyError(error, 'Could not change the stage.');
    }
  });
  const last = strategy.stageHistory?.at(-1);
  return h(
    'div',
    { class: 'flex flex-wrap items-center gap-2 text-xs text-muted' },
    label('Stage', selectId, 'text-xs'),
    picker,
    last ? h('span', {}, `since ${last.at.slice(0, 10)}`) : null,
    h(
      'span',
      { class: 'basis-full' },
      STRATEGY_STAGES.find((stage) => stage.value === strategy.stage)?.hint ?? '',
    ),
  );
}

/**
 * Builds a strategy card: edit/delete buttons, stage picker, performance of trades tagged
 * with the strategy, and its rules, improvements and notes.
 */
export function strategyCard(strategy, { trades, available, onEdit, onDelete, onChanged }) {
  const performance = summarisePerformance(
    trades.filter((trade) => trade.strategyId === strategy.id),
  );
  const metric = (text, value, tone = 'text-fg') =>
    h(
      'div',
      {},
      h('div', { class: 'text-xs text-muted' }, text),
      h('div', { class: `tnum mt-0.5 text-lg font-semibold ${tone}` }, value),
    );
  return card(
    { className: 'group relative' },
    cardHeader(
      '',
      h(
        'div',
        { class: 'flex w-full items-start justify-between gap-4' },
        h(
          'div',
          {},
          cardTitle(strategy.name),
          h('p', { class: 'mt-0.5 tnum text-xs text-subtle' }, strategy.date),
        ),
        h(
          'div',
          {
            class:
              'flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
          },
          button(icon('pencil', 14), {
            variant: 'ghost',
            size: 'sm',
            'aria-label': `Edit ${strategy.name}`,
            onclick: () => onEdit(strategy),
          }),
          button(icon('trash-2', 14), {
            variant: 'ghost',
            size: 'sm',
            className: 'text-negative hover:bg-negative-soft',
            'aria-label': `Delete ${strategy.name}`,
            onclick: () => onDelete(strategy),
          }),
        ),
      ),
    ),
    cardContent(
      'space-y-4',
      stageControl(strategy, { available, onChanged }),
      performance.totalTrades > 0
        ? h(
            'div',
            { class: 'grid grid-cols-3 gap-3 rounded-card border border-line bg-elevated p-4' },
            metric('Trades', String(performance.totalTrades)),
            metric('Win rate', `${performance.winRate.toFixed(0)}%`),
            metric(
              'Net P&L',
              formatCurrency(performance.netPnl),
              performance.netPnl >= 0 ? 'text-positive' : 'text-negative',
            ),
          )
        : h(
            'p',
            { class: 'rounded-card border border-dashed border-line p-4 text-sm text-muted' },
            'No trades tagged with this strategy yet, so there is nothing to measure.',
          ),
      h(
        'div',
        {},
        h('h4', { class: 'mb-1.5 text-sm font-medium text-fg' }, 'Rules'),
        h('p', { class: 'text-sm leading-relaxed whitespace-pre-line text-muted' }, strategy.rules),
      ),
      strategy.improvements
        ? h(
            'div',
            { class: 'rounded-r-card border-l-2 border-positive bg-elevated p-4' },
            h('h4', { class: 'mb-1.5 text-sm font-medium text-positive' }, 'Improvements'),
            h(
              'p',
              { class: 'text-sm leading-relaxed whitespace-pre-line text-muted' },
              strategy.improvements,
            ),
          )
        : null,
      strategy.notes
        ? h(
            'div',
            { class: 'rounded-r-card border-l-2 border-accent bg-elevated p-4' },
            h('h4', { class: 'mb-1.5 text-sm font-medium text-accent' }, 'Notes'),
            h(
              'p',
              { class: 'text-sm leading-relaxed whitespace-pre-line text-muted' },
              strategy.notes,
            ),
          )
        : null,
    ),
  );
}
