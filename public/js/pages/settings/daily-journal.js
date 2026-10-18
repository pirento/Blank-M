/**
 * Settings page — daily Telegram automation: the automatic journal (broker
 * fills after the close) and the pre-market plan (before the open).
 */
import { t } from '../../core/i18n.js';
import { $, h, card, cardHeader, cardTitle, cardContent, render } from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { cardDescription, statusLine } from './shared.js';

const MESSAGES = {
  dailyAutoImport: [
    'Today’s fills will be added after the close.',
    'The daily automatic journal is off.',
  ],
  premarketPlan: [
    'Your pre-market plan will arrive on Telegram before the open.',
    'The pre-market plan is off.',
  ],
};

/** Mounts the daily journal and pre-market plan toggles (stored with the report opt-ins). */
export function mountDailyJournal() {
  const state = {
    loading: true,
    values: { dailyAutoImport: false, premarketPlan: false },
    busy: false,
    message: '',
  };
  const root = $('[data-daily-journal]');

  async function load() {
    try {
      const result = await api('/api/account/notifications');
      state.values = {
        dailyAutoImport: result.dailyAutoImport,
        premarketPlan: result.premarketPlan,
      };
    } catch (error) {
      state.message = errorMessage(error, 'The daily journal setting could not be loaded.');
    } finally {
      state.loading = false;
      paint();
    }
  }

  async function save(field, enabled) {
    state.busy = true;
    state.message = '';
    paint();
    try {
      const result = await api('/api/account/notifications', {
        method: 'PUT',
        body: { [field]: enabled },
      });
      state.values[field] = result[field];
      state.message = MESSAGES[field][state.values[field] ? 0 : 1];
    } catch (error) {
      state.message = errorMessage(error, 'Could not update this setting.');
    } finally {
      state.busy = false;
      paint();
    }
  }

  function toggleRow(field, label, hint) {
    const toggle = h('input', {
      type: 'checkbox',
      class: 'mt-1 h-4 w-4 accent-accent',
      checked: state.values[field],
      disabled: state.loading || state.busy,
    });
    toggle.addEventListener('change', () => void save(field, toggle.checked));
    return h(
      'label',
      { class: 'flex items-start gap-3 text-sm' },
      toggle,
      h('span', {}, label, h('span', { class: 'block text-xs text-muted' }, hint)),
    );
  }

  function paint() {
    render(
      root,
      card(
        {},
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('Daily automatic journal')),
            cardDescription(
              'Every trading day at about 4:15 pm IST, today’s Zerodha and Dhan round trips are added to your journal and the day’s summary is sent to your linked Telegram chat.',
            ),
          ),
        ),
        cardContent(
          'space-y-4',
          toggleRow(
            'dailyAutoImport',
            'Add today’s broker fills to my journal after the close',
            'Zerodha needs the day’s login in Blank (its session ends each morning). Trades already in the journal are never added twice.',
          ),
          h('h3', { class: 'text-sm font-semibold' }, t('Pre-market plan on Telegram')),
          toggleRow(
            'premarketPlan',
            'Send me a pre-market plan at about 8:45 am IST on trading days',
            'Your watchlist, last session, recent mistakes, your own rules and today’s risk limits, with a few AI focus points when AI is set up. Needs a linked Telegram chat. Not investment advice.',
          ),
          statusLine(state.message),
        ),
      ),
    );
  }

  paint();
  void load();
}
