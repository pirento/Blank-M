/** Settings page — daily automatic journal (broker fills after the close). */
import { t } from '../../core/i18n.js';
import { $, h, card, cardHeader, cardTitle, cardContent, render } from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { cardDescription, statusLine } from './shared.js';

/** Mounts the toggle for the daily import (stored with the report opt-ins). */
export function mountDailyJournal() {
  const state = { loading: true, enabled: false, busy: false, message: '' };
  const root = $('[data-daily-journal]');

  async function load() {
    try {
      state.enabled = (await api('/api/account/notifications')).dailyAutoImport;
    } catch (error) {
      state.message = errorMessage(error, 'The daily journal setting could not be loaded.');
    } finally {
      state.loading = false;
      paint();
    }
  }

  async function save(enabled) {
    state.busy = true;
    state.message = '';
    paint();
    try {
      const result = await api('/api/account/notifications', {
        method: 'PUT',
        body: { dailyAutoImport: enabled },
      });
      state.enabled = result.dailyAutoImport;
      state.message = state.enabled
        ? 'Today’s fills will be added after the close.'
        : 'The daily automatic journal is off.';
    } catch (error) {
      state.message = errorMessage(error, 'Could not update the daily journal.');
    } finally {
      state.busy = false;
      paint();
    }
  }

  function paint() {
    const toggle = h('input', {
      type: 'checkbox',
      class: 'mt-1 h-4 w-4 accent-accent',
      checked: state.enabled,
      disabled: state.loading || state.busy,
    });
    toggle.addEventListener('change', () => void save(toggle.checked));
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
              'Every trading day at about 4:15 pm IST, today’s Zerodha, Dhan, Upstox, Fyers and Angel One round trips are added to your journal and the day’s summary is sent to your linked Telegram chat.',
            ),
          ),
        ),
        cardContent(
          'space-y-4',
          h(
            'label',
            { class: 'flex items-start gap-3 text-sm' },
            toggle,
            h(
              'span',
              {},
              'Add today’s broker fills to my journal after the close',
              h(
                'span',
                { class: 'block text-xs text-muted' },
                'Zerodha needs the day’s login in Blank (its session ends each morning). Trades already in the journal are never added twice.',
              ),
            ),
          ),
          statusLine(state.message),
        ),
      ),
    );
  }

  paint();
  void load();
}
