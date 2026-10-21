/**
 * Runs a real simulation over real candles. Every control on this page feeds
 * the engine; nothing is randomised.
 */
import { $, h, icon, pageData, button, emptyState, formatCurrency, render } from '../core/dom.js';
import { notify, notifyError } from '../core/toast.js';
import { errorMessage } from '../core/api.js';
import { fetchHistory } from '../lib/quotes.js';
import { saveStrategyEvidence } from '../lib/strategy-evidence.js';
import { strategySnapshotOf } from '../../../shared/strategy-evidence.js';
import { isBusinessDate } from '../../../shared/business-dates.js';
import {
  BacktestError,
  DEFAULT_STRATEGY_PARAMS,
  runBacktest,
} from '../../../shared/backtest/engine.js';
import { areaChart } from '../components/charts.js';

const STRATEGY_LABELS = {
  'sma-cross': 'SMA crossover',
  'ema-cross': 'EMA crossover',
  'rsi-reversion': 'RSI mean reversion',
};
const STRATEGY_DESCRIPTIONS = {
  'sma-cross':
    'Buy when the fast simple moving average crosses above the slow one; sell on the reverse cross.',
  'ema-cross': 'The same crossover logic, weighted towards recent prices.',
  'rsi-reversion':
    'Buy when RSI closes below the oversold level; sell when it closes above the overbought level.',
};

const data = pageData();
const workspace = data.workspace;
const available = Boolean(workspace);
const strategies = workspace?.strategies ?? [];
const form = $('[data-backtest-form]');
const fieldset = form.querySelector('fieldset');
const runButton = $('[data-run]');
const cancelButton = $('[data-cancel]');
const formError = $('[data-form-error]');
const state = {
  running: false,
  result: null,
  run: null,
  barsUsed: 0,
  savingEvidence: false,
  savedEvidence: false,
};
let pending = null;

function setFormError(message) {
  formError.textContent = message || '';
  formError.hidden = !message;
}

function syncKind() {
  const kind = form.elements.kind.value;
  $('[data-kind-description]').textContent = STRATEGY_DESCRIPTIONS[kind];
  $('[data-rsi-fields]').hidden = kind !== 'rsi-reversion';
  $('[data-ma-fields]').hidden = kind === 'rsi-reversion';
}
form.elements.kind.addEventListener('change', syncKind);

function metric(labelText, value, tone) {
  const toneClass =
    tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-fg';
  return h(
    'div',
    { class: 'rounded-card border border-line bg-surface p-4' },
    h('div', { class: 'text-xs text-muted' }, labelText),
    h('div', { class: `tnum mt-1.5 text-xl font-semibold tracking-tight ${toneClass}` }, value),
  );
}

async function saveEvidence() {
  const run = state.run;
  if (
    !available ||
    state.savingEvidence ||
    state.savedEvidence ||
    !run?.strategySnapshot ||
    !run.evidence
  )
    return;
  state.savingEvidence = true;
  paint();
  try {
    await saveStrategyEvidence({
      id: run.evidenceId,
      snapshot: run.strategySnapshot,
      evidence: run.evidence,
    });
    if (state.run !== run) return;
    state.savedEvidence = true;
    notify('Backtest evidence saved. Review this exact draft on the Strategy page.', 'success');
  } catch (error) {
    if (state.run === run)
      notifyError(
        error,
        'Could not save research evidence. You can retry this same completed run.',
      );
  } finally {
    state.savingEvidence = false;
    paint();
  }
}

function resultsView() {
  const { result, run } = state;
  const metrics = result.metrics;
  const charges = run.charges;
  const canvas = h('canvas', { 'aria-label': 'Equity curve', role: 'img' });
  const view = h(
    'div',
    { class: 'space-y-8' },
    h(
      'section',
      { class: 'space-y-2 text-sm', 'aria-label': 'Completed simulation inputs' },
      h('p', {}, `${run.symbol} · ${STRATEGY_LABELS[run.kind]} · ${run.from} to ${run.to}`),
      h(
        'p',
        { class: 'text-muted' },
        `${run.parameters}. Initial capital ${formatCurrency(run.capital)}; position size ${run.size}%; stop ${run.stopLoss}%; target ${run.takeProfit}%. These results retain the inputs used when the run started.`,
      ),
      h(
        'p',
        { class: 'text-xs text-muted' },
        'Start included; end excluded, using UTC boundaries. Only returned candles within this window are simulated.',
      ),
      h(
        'details',
        { class: 'text-xs text-muted' },
        h('summary', {}, 'Charge assumptions for this run'),
        h(
          'p',
          {},
          charges.enabled
            ? `Brokerage ${charges.brokeragePercent}% capped at ₹${charges.brokerageMaxPerOrder} per order; STT ${charges.sttPercent}%; exchange ${charges.exchangeTxnPercent}%; SEBI ${charges.sebiPercent}%; GST ${charges.gstPercent}%; stamp duty ${charges.stampDutyPercent}%.`
            : 'Charges were disabled for this simulation.',
        ),
      ),
    ),
    h(
      'section',
      { class: 'space-y-2 text-sm', 'aria-label': 'Save strategy evidence' },
      run.strategySnapshot
        ? [
            h(
              'p',
              {},
              `Frozen draft: ${run.strategySnapshot.name}. Saving links this completed simulation to that exact revision, regardless of subsequent form changes.`,
            ),
            button(
              state.savedEvidence
                ? 'Evidence saved'
                : state.savingEvidence
                  ? 'Saving evidence…'
                  : 'Save backtest evidence',
              {
                disabled: state.savingEvidence || state.savedEvidence,
                onclick: () => void saveEvidence(),
              },
            ),
            h(
              'p',
              { class: 'text-xs text-muted' },
              'Saved evidence contains the actual candle inputs, parameters, fees and full results. This client-computed research has no execution permission.',
            ),
          ]
        : h(
            'p',
            { class: 'text-muted' },
            'To retain evidence for review, select a saved draft before running a new backtest.',
          ),
    ),
    h(
      'p',
      { class: 'tnum text-xs text-muted' },
      `${state.barsUsed} daily bars • ${result.warmupBars} bars warm-up • ${metrics.exposurePercent}% time in market`,
    ),
    h(
      'div',
      { class: 'grid grid-cols-2 gap-4 md:grid-cols-4' },
      metric(
        'Net profit',
        `${metrics.netProfit >= 0 ? '+' : '-'}${formatCurrency(Math.abs(metrics.netProfit))}`,
        metrics.netProfit >= 0 ? 'positive' : 'negative',
      ),
      metric('Return', `${metrics.returnPercent}%`),
      metric('Win rate', `${metrics.winRate}%`),
      metric(
        'Profit factor',
        metrics.profitFactor === null ? 'No losses' : String(metrics.profitFactor),
      ),
      metric('Max drawdown', `-${metrics.maxDrawdownPercent}%`, 'negative'),
      metric('Trades', String(metrics.totalTrades)),
      metric('Sharpe', metrics.sharpeRatio === null ? 'n/a' : String(metrics.sharpeRatio)),
      metric('Charges paid', formatCurrency(metrics.totalCharges)),
    ),
    metrics.totalTrades === 0
      ? h(
          'p',
          {
            class:
              'rounded-card border border-dashed border-line-strong p-6 text-center text-sm text-muted',
          },
          'This strategy produced no trades over the selected range.',
        )
      : [
          h(
            'div',
            { class: 'w-full border-t border-line pt-4' },
            h('h4', { class: 'mb-4 text-sm font-medium text-fg' }, 'Equity curve'),
            h('div', { class: 'relative h-[280px]' }, canvas),
          ),
          h(
            'div',
            { class: 'border-t border-line pt-4' },
            h('h4', { class: 'mb-4 text-sm font-medium text-fg' }, 'Simulated trades'),
            h(
              'div',
              { class: 'max-h-64 overflow-y-auto' },
              h(
                'table',
                { class: 'w-full tnum text-xs' },
                h(
                  'thead',
                  { class: 'sticky top-0 bg-elevated text-left text-xs text-muted' },
                  h(
                    'tr',
                    {},
                    h('th', { class: 'py-2' }, 'Entry'),
                    h('th', {}, 'Exit'),
                    h('th', { class: 'text-right' }, 'Qty'),
                    h('th', { class: 'text-right' }, 'Net P&L'),
                    h('th', { class: 'pl-2' }, 'Reason'),
                  ),
                ),
                h(
                  'tbody',
                  {},
                  result.trades.map((trade) =>
                    h(
                      'tr',
                      { class: 'border-t border-line' },
                      h(
                        'td',
                        { class: 'py-2' },
                        `${new Date(trade.entryTime).toLocaleDateString('en-IN')} @ ${trade.entryPrice}`,
                      ),
                      h(
                        'td',
                        {},
                        `${new Date(trade.exitTime).toLocaleDateString('en-IN')} @ ${trade.exitPrice}`,
                      ),
                      h('td', { class: 'text-right' }, String(trade.quantity)),
                      h(
                        'td',
                        {
                          class: `text-right ${trade.netPnl >= 0 ? 'text-positive' : 'text-negative'}`,
                        },
                        `${trade.netPnl >= 0 ? '+' : '-'}${formatCurrency(Math.abs(trade.netPnl))}`,
                      ),
                      h('td', { class: 'pl-2 text-muted' }, trade.exitReason),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
    h(
      'p',
      { class: 'border-t border-line pt-4 text-xs leading-relaxed text-muted' },
      'Past performance of a simulated strategy does not predict future results. Fills are modelled at the next bar’s open with no slippage, and when a stop and target fall inside the same bar the stop is assumed to fill first.',
    ),
  );
  return { view, canvas };
}

function paint() {
  fieldset.disabled = state.running || state.savingEvidence || !available;
  runButton.disabled = state.running;
  render(
    runButton,
    state.running ? [icon('loader-2', 14, 'mr-2 animate-spin'), 'Running'] : 'Run backtest',
  );
  cancelButton.hidden = !state.running;
  const target = $('[data-results]');
  if (state.running) {
    render(
      target,
      h(
        'div',
        { class: 'flex h-full flex-col items-center justify-center py-20 text-subtle' },
        icon('loader-2', 28, 'mb-4 animate-spin'),
        h('p', { class: 'text-sm' }, 'Fetching candles and simulating…'),
      ),
    );
  } else if (state.result && state.run && available) {
    const { view, canvas } = resultsView();
    render(target, view);
    if (state.result.metrics.totalTrades > 0) {
      areaChart(canvas, {
        labels: state.result.equityCurve.map((point) =>
          new Date(point.time).toLocaleDateString('en-IN'),
        ),
        values: state.result.equityCurve.map((point) => point.equity),
        tooltipLabel: 'Equity',
      });
    }
  } else {
    render(
      target,
      emptyState({
        iconName: 'bar-chart-2',
        title: 'No simulation yet',
        hint: 'Configure a strategy and run it',
      }),
    );
  }
}

cancelButton.addEventListener('click', () => {
  pending?.abort();
  pending = null;
  state.running = false;
  paint();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pending || state.savingEvidence || !available) return;
  setFormError('');
  const values = Object.fromEntries(new FormData(form));
  const capital = Number(values.capital);
  const size = Number(values.size);
  const { from, to, kind } = values;
  if (!values.symbol.trim()) return setFormError('Enter a symbol to test.');
  if (!Number.isFinite(capital) || capital <= 0)
    return setFormError('Initial capital must be greater than zero.');
  if (!Number.isFinite(size) || size <= 0 || size > 100)
    return setFormError('Position size must be between 1% and 100%.');
  if (!isBusinessDate(from) || !isBusinessDate(to) || from >= to)
    return setFormError('The end date must be after the start date.');
  if (
    ![values.stopLoss, values.takeProfit].every(
      (value) => value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0,
    ) ||
    Number(values.stopLoss) >= 100
  ) {
    return setFormError(
      'Use a stop loss from 0% to less than 100% and a nonnegative take profit. Zero disables that exit.',
    );
  }
  const selectedStrategy = strategies.find((strategy) => strategy.id === values.strategyId);
  if (values.strategyId && !selectedStrategy) {
    return setFormError(
      'The selected draft is no longer available. Choose a current saved strategy.',
    );
  }
  const run = {
    symbol: values.symbol.trim().toUpperCase(),
    from,
    to,
    kind,
    parameters:
      kind === 'rsi-reversion'
        ? `RSI ${values.rsiPeriod}; oversold ${values.rsiOversold}; overbought ${values.rsiOverbought}`
        : `Fast ${values.fastPeriod}; slow ${values.slowPeriod}`,
    capital,
    size,
    stopLoss: Number(values.stopLoss),
    takeProfit: Number(values.takeProfit),
    charges: { ...workspace.settings.charges },
    strategySnapshot: selectedStrategy ? strategySnapshotOf(selectedStrategy) : null,
    evidenceId: crypto.randomUUID(),
  };
  const controller = new AbortController();
  pending = controller;
  const current = () => pending === controller && !controller.signal.aborted;
  Object.assign(state, { running: true, result: null, run: null, savedEvidence: false });
  paint();
  try {
    const history = await fetchHistory(
      { symbol: run.symbol, from, to, interval: '1d' },
      controller.signal,
    );
    if (!current()) return;
    if (history.some((candle) => !candle || !Number.isFinite(candle.time))) {
      throw new BacktestError('Price history contains invalid candle timestamps.');
    }
    // Compare IST trading days: providers stamp daily candles at 00:00 IST (18:30 UTC the day
    // before) or 09:15 IST, so raw UTC instants would move a day in or out of the range.
    const istDay = (time) => new Date(time + 330 * 60_000).toISOString().slice(0, 10);
    const candles = history.filter((candle) => {
      const day = istDay(candle.time);
      return day >= from && day < to;
    });
    state.barsUsed = candles.length;
    const params = {
      ...DEFAULT_STRATEGY_PARAMS,
      kind,
      fastPeriod: Number(values.fastPeriod),
      slowPeriod: Number(values.slowPeriod),
      rsiPeriod: Number(values.rsiPeriod),
      rsiOversold: Number(values.rsiOversold),
      rsiOverbought: Number(values.rsiOverbought),
    };
    const config = {
      initialCapital: capital,
      positionSizePercent: size,
      stopLossPercent: run.stopLoss,
      takeProfitPercent: run.takeProfit,
      charges: run.charges,
    };
    const simulation = runBacktest(candles, params, config);
    run.evidence = {
      schemaVersion: 1,
      engineVersion: 'blank-daily-long-v1',
      provenance: 'client-computed-unverified',
      symbol: run.symbol,
      from: run.from,
      to: run.to,
      params,
      config,
      candles: candles.map((candle) => ({ ...candle })),
      result: simulation,
    };
    state.result = simulation;
    state.run = run;
  } catch (error) {
    if (!current()) return;
    if (error instanceof BacktestError) setFormError(error.message);
    else notify(errorMessage(error, 'Could not run the backtest.'), 'error');
  } finally {
    if (pending === controller) {
      pending = null;
      state.running = false;
      paint();
    }
  }
});

syncKind();
paint();
