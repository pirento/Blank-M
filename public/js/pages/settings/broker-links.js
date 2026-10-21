/**
 * Settings page — Upstox, Fyers and Angel One: read-only connections that
 * bring today's fills into the journal. Upstox and Fyers log in on the
 * broker's own page (OAuth); Angel One takes the member's SmartAPI details,
 * of which only the API key and the session are kept.
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

const BROKERS = () => [
  {
    key: 'upstox',
    label: 'Upstox',
    title: t('Upstox'),
    oauth: true,
    description: t(
      'Read-only: brings today’s Upstox fills into the journal. You log in on Upstox’s own page; the access token is stored encrypted and lasts until 3:30 am IST.',
    ),
    missingKeys: t('The administrator has not set Upstox app keys yet.'),
    connect: t('Connect Upstox'),
    add: t('Add today’s Upstox fills to journal'),
  },
  {
    key: 'fyers',
    label: 'Fyers',
    title: t('Fyers'),
    oauth: true,
    description: t(
      'Read-only: brings today’s Fyers fills into the journal. You log in on Fyers’ own page; the access token is stored encrypted and lasts for the trading day.',
    ),
    missingKeys: t('The administrator has not set Fyers app keys yet.'),
    connect: t('Connect Fyers'),
    add: t('Add today’s Fyers fills to journal'),
  },
  {
    key: 'angel',
    label: 'Angel One',
    title: t('Angel One'),
    oauth: false,
    description: t(
      'Read-only: brings today’s Angel One fills into the journal. Create a SmartAPI app at smartapi.angelbroking.com for your API key. Your PIN and authenticator code are sent to Angel One once and never stored; the session lasts until midnight IST.',
    ),
    connect: t('Connect Angel One'),
    add: t('Add today’s Angel One fills to journal'),
  },
];

/** Mounts one card per broker into its `[data-<broker>]` slot; shows the result of an OAuth return. */
export function mountBrokerLinks() {
  const params = new URLSearchParams(window.location.search);
  const returned = params.get('broker');
  const result = params.get('result');
  for (const broker of BROKERS()) {
    const root = $(`[data-${broker.key}]`);
    if (!root) continue;
    if (returned === broker.key) {
      history.replaceState(history.state, '', `${window.location.pathname}${window.location.hash}`);
      if (result === 'connected') notify(`${broker.label} connected.`, 'success');
      else notify(`${broker.label} connection failed. Start again.`, 'error');
    }
    mountCard(root, broker);
  }
}

function mountCard(root, broker) {
  const state = { status: null, busy: false, error: '' };
  const field = (id, attributes) =>
    input({ id: `${broker.key}-${id}`, autocomplete: 'off', spellcheck: 'false', ...attributes });
  const fields = broker.oauth
    ? null
    : {
        apiKey: field('api-key', { type: 'password' }),
        clientCode: field('client-code', { type: 'text' }),
        pin: field('pin', { type: 'password', inputmode: 'numeric' }),
        totp: field('totp', { type: 'text', inputmode: 'numeric', maxlength: '6' }),
      };

  async function load() {
    try {
      state.status = await api(`/api/${broker.key}`);
    } catch (error) {
      state.error = errorMessage(error, `${broker.label} settings could not be loaded.`);
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

  const startLogin = () =>
    run(async () => {
      const { url } = await api(`/api/${broker.key}/authorize`, { method: 'POST' });
      window.location.href = url;
    });

  const loginAngel = () =>
    run(async () => {
      try {
        state.status = await api('/api/angel/connect', {
          method: 'POST',
          body: Object.fromEntries(Object.entries(fields).map(([name, el]) => [name, el.value])),
        });
        fields.apiKey.value = '';
        fields.clientCode.value = '';
        notify('Angel One connected.', 'success');
      } finally {
        // A PIN or one-time code never stays in the page.
        fields.pin.value = '';
        fields.totp.value = '';
      }
    });

  function connectControls(status) {
    if (broker.oauth) {
      if (!status.configured) return h('p', { class: 'text-sm text-muted' }, broker.missingKeys);
      return h(
        'div',
        { class: 'flex flex-wrap gap-2' },
        button(state.busy ? 'Opening…' : broker.connect, {
          disabled: state.busy,
          onclick: () => void startLogin(),
        }),
      );
    }
    const row = (text, element) =>
      h('div', { class: 'space-y-2' }, label(text, element.id), element);
    return h(
      'form',
      {
        class: 'grid gap-3 sm:grid-cols-2',
        onsubmit: (event) => {
          event.preventDefault();
          void loginAngel();
        },
      },
      row(t('SmartAPI API key'), fields.apiKey),
      row(t('Client code'), fields.clientCode),
      row(t('PIN'), fields.pin),
      row(t('Authenticator code'), fields.totp),
      h(
        'div',
        { class: 'sm:col-span-2' },
        button(state.busy ? 'Connecting…' : broker.connect, {
          type: 'submit',
          disabled: state.busy,
        }),
      ),
    );
  }

  function paint() {
    const status = state.status;
    const message = !status
      ? 'Loading…'
      : status.connected
        ? `Connected to ${broker.label}${status.clientId ? ` client ${status.clientId}` : ''}. Valid until ${formatIstDateTime(status.expiresAt)}.`
        : status.expired
          ? `The ${broker.label} login has expired. Connect again.`
          : 'Not connected.';
    const disconnect = () =>
      button(t('Disconnect'), {
        variant: 'ghost',
        className: 'text-negative',
        disabled: state.busy,
        onclick: () =>
          void run(async () => {
            state.status = await api(`/api/${broker.key}/disconnect`, { method: 'POST' });
            notify(`${broker.label} disconnected.`, 'success');
          }),
      });
    render(
      root,
      card(
        {},
        cardHeader('', h('div', {}, cardTitle(broker.title), cardDescription(broker.description))),
        cardContent(
          'space-y-4',
          statusLine(message),
          state.error ? errorLine(state.error) : null,
          status && !status.connected ? connectControls(status) : null,
          status?.connected
            ? h(
                'div',
                { class: 'flex flex-wrap gap-2' },
                button(broker.add, {
                  disabled: state.busy,
                  onclick: () =>
                    // The dialog reports what was added; nothing on this page changes.
                    openFillsToJournal({ broker: broker.key, onAdded: () => undefined }),
                }),
                disconnect(),
              )
            : null,
          // An expired login keeps its account link; Disconnect lets another account be linked.
          status && !status.connected && (status.expired || status.clientId) ? disconnect() : null,
        ),
      ),
    );
  }
  paint();
  void load();
}
