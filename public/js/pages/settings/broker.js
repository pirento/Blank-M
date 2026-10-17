/** Settings page — broker connection. */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  icon,
  button,
  badge,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  render,
  formatIstDateTime,
} from '../../core/dom.js';
import { api } from '../../core/api.js';
import { notify, notifyError } from '../../core/toast.js';
import {
  completeBrokerConnect,
  disconnectBrokerSession,
  fetchBrokerStatus,
  startBrokerConnect,
} from '../../lib/quotes.js';
import { cardDescription, data } from './shared.js';

/**
 * Mounts the Zerodha connection card: shows broker status, starts and disconnects the
 * connection and refreshes instruments. Handles the `?kite=` redirect marker on return.
 */
export function mountBroker() {
  const state = { broker: null, pending: false, busy: null, confirmDisconnect: false };
  let statusRevision = 0;
  const root = $('[data-broker]');

  async function refreshBroker() {
    const revision = ++statusRevision;
    const status = await fetchBrokerStatus();
    if (revision !== statusRevision) return null;
    state.broker = status;
    paint();
    return status;
  }

  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('kite');
  // A redirect marker is only a prompt to confirm, never proof of connection.
  if (params.has('kite'))
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.hash}`);
  if (outcome === 'pending') state.pending = true;
  else if (outcome === 'failed' || outcome === 'missing')
    notify('Zerodha connection failed. Start a new connection and try again.', 'error');
  void refreshBroker().catch(() => {
    // Leave status unknown when it cannot be verified.
  });

  async function guarded(kind, action) {
    if (state.busy) return;
    state.busy = kind;
    paint();
    try {
      await action();
    } finally {
      state.busy = null;
      paint();
    }
  }

  const connect = () =>
    guarded('starting', async () => {
      state.pending = false;
      state.confirmDisconnect = false;
      try {
        window.location.href = await startBrokerConnect();
      } catch (error) {
        notifyError(error, 'Could not start the Zerodha connection.');
      }
    });

  const finish = () =>
    guarded('finishing', async () => {
      try {
        await completeBrokerConnect();
        state.pending = false;
        const status = await refreshBroker();
        if (!status) return;
        if (status.connected) notify('Zerodha Kite connected.', 'success');
        else notify('Zerodha connection could not be verified. Try connecting again.', 'error');
      } catch (error) {
        state.pending = false;
        notifyError(error, 'Could not finish the Zerodha connection.');
      }
    });

  const disconnect = () =>
    guarded('disconnecting', async () => {
      statusRevision++;
      try {
        await disconnectBrokerSession();
        const status = await refreshBroker();
        if (!status) return;
        state.confirmDisconnect = false;
        state.pending = false;
        if (status.connected)
          notify(
            'An active broker session is present. Another connection may have completed; review the current status.',
            'error',
          );
        else
          notify(
            'Broker session disconnected. Existing broker identity is retained; positions were not changed.',
            'success',
          );
      } catch (error) {
        state.confirmDisconnect = false;
        state.broker = null;
        notifyError(
          error,
          'Could not verify disconnection. Refresh broker status before trying again.',
        );
      }
    });

  /** Administrators can rebuild the NSE instrument master used to resolve symbols. */
  const refreshInstruments = () =>
    guarded('instruments', async () => {
      try {
        const result = await api('/api/instruments/refresh', {
          method: 'POST',
          body: {},
          timeout: 120_000,
        });
        notify(
          `Instrument list refreshed: ${Number(result.loaded).toLocaleString('en-IN')} NSE equities loaded.`,
          'success',
        );
        await refreshBroker();
      } catch (error) {
        notifyError(error, 'Could not refresh the instrument list.');
      }
    });

  const refreshStatus = () =>
    guarded('refreshing', async () => {
      try {
        await refreshBroker();
      } catch (error) {
        notifyError(error, 'Could not refresh broker status.');
      }
    });

  function paint() {
    const { broker, busy } = state;
    const statusBadge = broker?.connected
      ? badge('Zerodha connected', 'positive')
      : broker?.configured
        ? badge('Reconnect required', 'caution')
        : badge(broker ? 'Yahoo fallback' : 'Status unavailable', 'neutral');
    const parts = [
      h(
        'dl',
        { class: 'preference-ledger' },
        h(
          'div',
          {},
          h('dt', {}, 'Zerodha'),
          h(
            'dd',
            {},
            !broker
              ? 'Status unverified'
              : broker.connected
                ? 'Connected'
                : broker.configured
                  ? 'Not connected'
                  : 'Not configured',
          ),
        ),
        h('div', {}, h('dt', {}, 'Broker balance'), h('dd', {}, 'Not verified')),
        h('div', {}, h('dt', {}, 'Live execution'), h('dd', {}, 'Disabled')),
      ),
    ];
    if (state.pending) {
      parts.push(
        h(
          'div',
          { class: 'space-y-3 rounded-control border border-line bg-elevated p-3' },
          h(
            'p',
            { class: 'text-sm text-muted' },
            'Zerodha returned a pending connection. Confirm promptly using the same recently signed-in Blank account.',
          ),
          button(
            [
              icon('shield-check', 14, 'mr-2'),
              busy === 'finishing' ? 'Finishing connection…' : 'Finish connecting Zerodha',
            ],
            { disabled: busy !== null, onclick: () => void finish() },
          ),
        ),
      );
    }
    if (broker?.configured) {
      parts.push(
        h(
          'p',
          { class: 'text-sm text-muted' },
          'Kite access expires at 06:00 IST the following day.',
          broker.expiresAt && broker.connected
            ? ` Current session: ${formatIstDateTime(broker.expiresAt)} IST.`
            : '',
        ),
        broker.instruments > 0
          ? h(
              'p',
              { class: 'text-xs text-subtle' },
              `${broker.instruments.toLocaleString('en-IN')} NSE equity instruments indexed.`,
            )
          : h(
              'p',
              { class: 'text-xs text-subtle' },
              'The NSE instrument list has not been loaded yet.',
            ),
        data.role === 'admin'
          ? button(
              [
                icon('refresh-cw', 14, 'mr-2'),
                busy === 'instruments'
                  ? 'Refreshing instrument list…'
                  : 'Refresh NSE instrument list',
              ],
              {
                variant: 'ghost',
                size: 'sm',
                disabled: busy !== null,
                onclick: () => void refreshInstruments(),
              },
            )
          : null,
        button(
          [
            icon('link-2', 14, 'mr-2'),
            busy === 'starting'
              ? 'Starting connection…'
              : broker.connected
                ? 'Reconnect Zerodha'
                : 'Connect Zerodha',
          ],
          {
            variant: 'outline',
            disabled: busy !== null,
            onclick: () => void connect(),
          },
        ),
      );
      if (broker.connected) {
        parts.push(
          h(
            'div',
            { class: 'space-y-3' },
            state.confirmDisconnect
              ? h(
                  'div',
                  { class: 'space-y-3 rounded-control border border-line bg-elevated p-3' },
                  h(
                    'p',
                    { class: 'text-sm text-muted' },
                    "Disconnect this app's broker session? Your stored broker identity is retained until an approved replacement process is available. This does not cancel orders, close positions or sign you out of Zerodha.",
                  ),
                  h(
                    'div',
                    { class: 'flex flex-wrap gap-2' },
                    button(
                      busy === 'disconnecting'
                        ? 'Disconnecting session…'
                        : 'Confirm disconnect session',
                      {
                        variant: 'destructive',
                        disabled: busy !== null,
                        onclick: () => void disconnect(),
                      },
                    ),
                    button(t('Cancel'), {
                      variant: 'outline',
                      disabled: busy !== null,
                      onclick: () => {
                        state.confirmDisconnect = false;
                        paint();
                      },
                    }),
                  ),
                )
              : button(t('Disconnect session'), {
                  variant: 'outline',
                  disabled: busy !== null,
                  onclick: () => {
                    state.confirmDisconnect = true;
                    paint();
                  },
                }),
            h(
              'p',
              { class: 'text-xs text-muted' },
              "Disconnecting expires this app's session, while retaining the broker account identity. It does not unlink or replace the broker account.",
            ),
          ),
        );
      }
    } else {
      parts.push(
        h(
          'p',
          { class: 'text-sm text-muted' },
          broker
            ? 'Zerodha credentials are not configured on this deployment. Quotes and backtests use the fallback provider until an administrator completes setup.'
            : 'The Zerodha connection status could not be verified yet.',
        ),
      );
    }
    if (!broker) {
      parts.push(
        button(busy === 'refreshing' ? 'Refreshing broker status…' : 'Refresh broker status', {
          variant: 'outline',
          disabled: busy !== null,
          onclick: () => void refreshStatus(),
        }),
      );
    }
    render(
      root,
      card(
        {},
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('Trading connection')),
            cardDescription(
              t(
                'Zerodha Kite is preferred for authenticated NSE data; Yahoo remains the automatic fallback.',
              ),
            ),
          ),
          statusBadge,
        ),
        cardContent('space-y-4', parts),
      ),
    );
  }
  paint();
}
