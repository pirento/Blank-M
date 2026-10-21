/**
 * Settings page — Dhan: connect with a personal access token (created in
 * Dhan's web console), then add today's Dhan fills to the journal.
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
  input,
  label,
  render,
  errorLine,
  formatIstDateTime,
} from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { notify } from '../../core/toast.js';
import { openFillsToJournal } from '../../components/fills-to-journal.js';
import { cardDescription, statusLine } from './shared.js';

/**
 * Mounts the Dhan card: connect with an access token, disconnect, and add today's Dhan
 * fills to the journal. Does nothing when the page has no Dhan slot.
 */
export function mountDhan() {
  const root = $('[data-dhan]');
  if (!root) return;
  const state = { status: null, busy: false, error: '' };
  const tokenInput = input({
    id: 'dhan-token',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: t('Paste the access token'),
  });

  async function load() {
    try {
      state.status = await api('/api/dhan');
    } catch (error) {
      state.error = errorMessage(error, 'Dhan settings could not be loaded.');
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

  const connect = () =>
    run(async () => {
      state.status = await api('/api/dhan/connect', {
        method: 'POST',
        body: { accessToken: tokenInput.value },
      });
      tokenInput.value = '';
      notify('Dhan connected.', 'success');
    });

  function paint() {
    const status = state.status;
    const message = !status
      ? 'Loading…'
      : status.connected
        ? `Connected to Dhan client ${status.clientId}. The token is valid until ${formatIstDateTime(status.expiresAt)}.`
        : status.expired
          ? `The Dhan token for client ${status.clientId} has expired. Paste a new one to reconnect.`
          : 'Not connected.';
    const disconnect = () =>
      button(t('Disconnect'), {
        variant: 'ghost',
        className: 'text-negative',
        disabled: state.busy,
        onclick: () =>
          void run(async () => {
            state.status = await api('/api/dhan/disconnect', { method: 'POST' });
            notify('Dhan disconnected.', 'success');
          }),
      });
    render(
      root,
      card(
        {},
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('Dhan')),
            cardDescription(
              t(
                'Read-only: brings today’s Dhan fills into the journal. Create an access token at web.dhan.co → My Profile → DhanHQ Trading APIs. It is stored encrypted and never shown again.',
              ),
            ),
          ),
        ),
        cardContent(
          'space-y-4',
          statusLine(message),
          state.error ? errorLine(state.error) : null,
          status && !status.connected
            ? h(
                'form',
                {
                  class: 'flex flex-col gap-2 sm:flex-row sm:items-end',
                  onsubmit: (event) => {
                    event.preventDefault();
                    void connect();
                  },
                },
                h(
                  'div',
                  { class: 'flex-1 space-y-2' },
                  label(t('Access token'), 'dhan-token'),
                  tokenInput,
                ),
                button(state.busy ? 'Connecting…' : 'Connect Dhan', {
                  type: 'submit',
                  disabled: state.busy,
                }),
              )
            : null,
          status?.connected
            ? h(
                'div',
                { class: 'flex flex-wrap gap-2' },
                button(t('Add today’s Dhan fills to journal'), {
                  disabled: state.busy,
                  onclick: () =>
                    // The dialog reports what was added; nothing on this page changes.
                    openFillsToJournal({ broker: 'dhan', onAdded: () => undefined }),
                }),
                disconnect(),
              )
            : null,
          // An expired token keeps its account link; Disconnect lets another account be linked.
          status && !status.connected && (status.expired || status.clientId) ? disconnect() : null,
        ),
      ),
    );
  }
  paint();
  void load();
}
