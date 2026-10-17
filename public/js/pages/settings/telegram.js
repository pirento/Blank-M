/**
 * Settings page — Telegram: link a chat with a one-time link (valid 10
 * minutes), then log trades and get summaries and price alerts in Telegram.
 */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  button,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  render,
  errorLine,
} from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { notify } from '../../core/toast.js';
import { cardDescription, statusLine } from './shared.js';

/** Mounts the Telegram card: shows link status, creates a one-time link URL, or unlinks the chat. */
export function mountTelegram() {
  const root = $('[data-telegram]');
  if (!root) return;
  const state = { status: null, link: null, busy: false, error: '' };

  async function load() {
    try {
      state.status = await api('/api/telegram');
    } catch (error) {
      state.error = errorMessage(error, 'Telegram settings could not be loaded.');
    }
    paint();
  }

  async function run(action) {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    paint();
    try {
      await action();
    } catch (error) {
      state.error = errorMessage(error, 'That did not work. Try again.');
    } finally {
      state.busy = false;
      paint();
    }
  }

  function paint() {
    const status = state.status;
    const message = !status
      ? 'Loading…'
      : !status.configured
        ? 'Telegram is not configured on this server.'
        : status.linked
          ? `Linked${status.username ? ` to ${status.username}` : ''}. Send /help to the bot for commands.`
          : 'Not linked.';
    render(
      root,
      card(
        {},
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('Telegram')),
            cardDescription(
              t(
                'Log trades from chat (/log INFY LONG 10 1500 1520), get today’s and the week’s P&L, and receive price alerts.',
              ),
            ),
          ),
        ),
        cardContent(
          'space-y-4',
          statusLine(message),
          state.error ? errorLine(state.error) : null,
          state.link && !status?.linked
            ? h(
                'div',
                { class: 'space-y-2 rounded-control border border-accent p-3 text-sm' },
                h(
                  'p',
                  {},
                  'Open this link on the phone or computer where you use Telegram and press Start (valid for 10 minutes):',
                ),
                h(
                  'a',
                  {
                    href: state.link,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    class: 'focus-ring break-all text-accent underline',
                  },
                  state.link,
                ),
                button(t('I pressed Start'), {
                  variant: 'outline',
                  size: 'sm',
                  onclick: () => void load(),
                }),
              )
            : null,
          h(
            'div',
            { class: 'flex flex-wrap gap-2' },
            status?.configured && !status.linked
              ? button(state.link ? 'Create a new link' : 'Link Telegram', {
                  disabled: state.busy,
                  onclick: () =>
                    void run(async () => {
                      state.link = (await api('/api/telegram/link', { method: 'POST' })).url;
                    }),
                })
              : null,
            status?.linked
              ? button(t('Unlink'), {
                  variant: 'ghost',
                  className: 'text-negative',
                  disabled: state.busy,
                  onclick: () =>
                    void run(async () => {
                      state.status = await api('/api/telegram/unlink', { method: 'POST' });
                      state.link = null;
                      notify('Telegram unlinked.', 'success');
                    }),
                })
              : null,
          ),
        ),
      ),
    );
  }
  paint();
  void load();
}
