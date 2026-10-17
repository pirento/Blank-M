/**
 * Where a strategy is in its life: written down, tested on history, tried
 * with paper money, traded live, or retired. Each change is kept with its
 * date so the strategy page can show how it got where it is.
 */
export const STRATEGY_STAGES = [
  { value: 'draft', label: 'Draft', hint: 'Written down, not tested yet.' },
  { value: 'backtested', label: 'Backtested', hint: 'Checked on past candles.' },
  { value: 'paper', label: 'Paper trading', hint: 'Tried at live prices without real orders.' },
  { value: 'live', label: 'Live', hint: 'Traded with real money.' },
  { value: 'retired', label: 'Retired', hint: 'No longer traded.' },
];
export const STAGE_VALUES = STRATEGY_STAGES.map((stage) => stage.value);
export const MAX_STAGE_HISTORY = 50;

/** Display label for a stage value; unknown values read as 'Draft'. */
export const stageLabel = (value) =>
  STRATEGY_STAGES.find((stage) => stage.value === value)?.label ?? 'Draft';
