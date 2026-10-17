/**
 * Capital card, briefing section and the page paint.
 */
import {
  $,
  h,
  icon,
  formatCurrency,
  button,
  buttonClass,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  input,
  render,
  errorLine,
} from '../../core/dom.js';
import { describeMarketStatus, getMarketStatus, toIst } from '../../../../shared/market.js';
import { aiUnavailableNotice } from '../../components/ai-gate.js';
import { prepareBriefing, runAnalysis, updateCapital } from './actions.js';
import { selection } from './archive.js';
import { history } from './history.js';
import { aiAvailable, allowed, citations, portfolioBalance, settings, state } from './shared.js';
import { analysisStatus, shortlist } from './shortlist.js';

function capitalCard() {
  const content = cardContent(
    '',
    h(
      'dl',
      { class: 'space-y-3 text-sm' },
      h(
        'div',
        { class: 'flex justify-between gap-3' },
        h('dt', { class: 'text-muted' }, 'Opening balance'),
        h('dd', {}, formatCurrency(settings.openingBalance)),
      ),
      h(
        'div',
        { class: 'flex justify-between gap-3' },
        h('dt', { class: 'text-muted' }, 'Journal balance'),
        h('dd', {}, formatCurrency(portfolioBalance)),
      ),
    ),
    h(
      'p',
      { class: 'my-4 text-xs text-muted' },
      'Opening balance plus net P&L from loaded journal trades. This is not a broker-confirmed balance.',
    ),
  );
  if (state.editingAmount) {
    const amount = input({
      type: 'text',
      inputmode: 'decimal',
      'aria-label': 'New opening amount',
      value: state.openingAmount,
      className: 'min-w-0 flex-1',
      oninput: (event) => {
        state.openingAmount = event.target.value;
      },
    });
    content.append(
      h(
        'form',
        { class: 'flex flex-wrap gap-2', onsubmit: (event) => void updateCapital(event) },
        amount,
        h(
          'button',
          { type: 'submit', class: buttonClass(), disabled: state.savingAmount || !allowed },
          state.savingAmount ? 'Saving…' : 'Update',
        ),
        button('Cancel', {
          variant: 'outline',
          disabled: state.savingAmount,
          onclick: () => {
            state.editingAmount = false;
            paint();
          },
        }),
      ),
    );
    queueMicrotask(() => amount.focus());
  } else {
    content.append(
      button('Set opening amount', {
        variant: 'outline',
        disabled: !allowed,
        onclick: () => {
          state.editingAmount = true;
          paint();
        },
      }),
    );
  }
  return card({}, cardHeader('', cardTitle('Planning capital')), content);
}

function briefingSection() {
  const action = aiAvailable
    ? button(
        state.briefingLoading
          ? 'Preparing…'
          : state.briefing
            ? 'Refresh briefing'
            : 'Prepare briefing',
        {
          variant: 'outline',
          disabled: !allowed || state.briefingLoading,
          onclick: () => void prepareBriefing(),
        },
      )
    : aiUnavailableNotice('Market briefing');
  const content = cardContent('', errorLine(state.briefingError));
  const b = state.briefing;
  content.append(
    b
      ? h(
          'div',
          { class: 'space-y-4' },
          h('p', { class: 'text-sm leading-6' }, b.overview),
          [
            ['Market drivers', b.marketDrivers],
            ['Risk events', b.riskEvents],
            ['Preparation', b.preparation],
          ].map(([title, items]) =>
            h(
              'div',
              {},
              h('h3', { class: 'text-sm font-semibold' }, title),
              h(
                'ul',
                { class: 'mt-2 list-inside list-disc space-y-1 text-xs text-muted' },
                items.map((item) => h('li', {}, item)),
              ),
            ),
          ),
          citations(b.citations),
        )
      : h(
          'p',
          { class: 'text-sm text-muted' },
          'Cited market context for preparation. No briefing is generated until you request one.',
        ),
  );
  return card(
    {},
    cardHeader(
      '',
      h(
        'h3',
        { class: 'text-base font-normal text-fg' },
        h(
          'span',
          { class: 'flex items-center gap-2' },
          icon('newspaper', 17),
          'AI market briefing',
        ),
      ),
      action,
    ),
    content,
  );
}

/**
 * Repaints the Today page: run/cancel analysis controls, status strip, market clock line,
 * shortlist, research history, capital card and market briefing.
 */
export function paint() {
  const now = new Date();
  const ist = toIst(now);
  const { selected, selectedLocal, selectedCloud, selectedDate } = selection();
  render(
    $('[data-run-slot]'),
    button(
      [
        state.analysis ? icon('loader-2', 14, 'mr-2 animate-spin') : '',
        state.analysis ? 'Analysing market…' : 'Run analysis',
        icon('arrow-right', 14, 'ml-2'),
      ],
      {
        disabled: !allowed || Boolean(state.analysis) || !aiAvailable,
        onclick: () => void runAnalysis(),
      },
    ),
  );
  render(
    $('[data-today-root]'),
    h(
      'div',
      { class: 'space-y-6' },
      !aiAvailable ? aiUnavailableNotice('Stock pickup') : null,
      h(
        'div',
        { class: 'research-strip' },
        [
          ['UNIVERSE', 'NIFTY 500'],
          ['MARKET REGIME', 'Unverified'],
          ['VOLATILITY', 'Awaiting data'],
          ['ANALYSIS', analysisStatus(selected)],
        ].map(([label, value]) => h('div', {}, h('small', {}, label), h('strong', {}, value))),
      ),
      h(
        'p',
        { class: 'text-xs text-muted', 'data-clock-line': '' },
        `${ist.date} · ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')} IST · ${describeMarketStatus(getMarketStatus(now))}. Session hours are indicative; verify exchange notices.`,
      ),
      errorLine(state.researchError),
      state.analysis
        ? button('Cancel analysis', {
            variant: 'outline',
            onclick: () => state.analysis?.controller.abort(),
          })
        : null,
      shortlist(selected, selectedDate, ist),
      h(
        'div',
        { class: 'research-method' },
        h('span', { class: 'eyebrow' }, 'WHAT THE ANALYSIS WILL COVER'),
        [
          ['01', 'Market conditions', 'Trend, breadth, liquidity and measured volatility.'],
          ['02', 'Selection evidence', 'Strategy fit and the reasons behind each candidate.'],
          ['03', 'Invalidation', 'Missing data and conditions that call for waiting.'],
        ].map(([number, title, detail]) =>
          h('div', {}, h('span', {}, number), h('h3', {}, title), h('p', {}, detail)),
        ),
      ),
      history(selected, selectedLocal, selectedCloud, selectedDate),
      h('div', { class: 'grid gap-6 lg:grid-cols-2' }, capitalCard(), briefingSection()),
    ),
  );
}

// Keep the IST line current without rebuilding interactive controls.
