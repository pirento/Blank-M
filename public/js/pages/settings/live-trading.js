/** Settings page — live orders. */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  badge,
  select,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  formatCurrency,
  render,
} from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { cardDescription, statusLine } from './shared.js';

/**
 * Mounts the live orders card: loads live order state, toggles it for the account via
 * PUT /api/account/live-trading (enabling needs the server feature and verified MFA) and
 * chooses the broker orders go to via PUT /api/account/live-order-broker.
 */
export function mountLiveTrading() {
  const state = { live: null, busy: false, message: '' };
  const root = $('[data-live-trading]');
  async function load() {
    try {
      state.live = (await api('/api/live-orders')).state;
    } catch (error) {
      state.message = errorMessage(error, 'Live order settings could not be loaded.');
    }
    paint();
  }
  function paint() {
    const live = state.live;
    const toggle = h('input', {
      type: 'checkbox',
      class: 'mt-1 h-4 w-4 accent-accent',
      checked: Boolean(live?.accountEnabled),
      disabled:
        !live || state.busy || (!live.accountEnabled && (!live.serverEnabled || !live.mfaVerified)),
    });
    // Only connected brokers that take orders can be chosen; the current one stays listed.
    const choices = (live?.brokers ?? []).filter(
      (broker) =>
        broker.provider === live.broker.provider ||
        (broker.connected && broker.capabilities.orders),
    );
    const brokerPicker = select(
      { id: 'live-order-broker', disabled: state.busy || choices.length < 2 },
      choices.map((broker) => ({
        value: broker.provider,
        selected: broker.provider === live.broker.provider,
        label: broker.connected ? broker.label : `${broker.label} (not connected)`,
      })),
    );
    brokerPicker.addEventListener('change', async () => {
      state.busy = true;
      state.message = '';
      paint();
      try {
        state.live = (
          await api('/api/account/live-order-broker', {
            method: 'PUT',
            body: { broker: brokerPicker.value },
          })
        ).state;
        state.message = `Live orders now go to ${state.live.broker.label}.`;
      } catch (error) {
        state.message = errorMessage(error, 'Could not change the live order broker.');
      } finally {
        state.busy = false;
        paint();
      }
    });
    toggle.addEventListener('change', async () => {
      state.busy = true;
      state.message = '';
      paint();
      try {
        state.live = (
          await api('/api/account/live-trading', {
            method: 'PUT',
            body: { enabled: toggle.checked },
          })
        ).state;
        state.message = state.live.accountEnabled
          ? 'Live orders are enabled for your account.'
          : 'Live orders are disabled for your account.';
      } catch (error) {
        state.message = errorMessage(error, 'Could not change live orders.');
      } finally {
        state.busy = false;
        paint();
      }
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
            cardTitle(t('Live orders')),
            cardDescription(
              t('Send reviewed plans to your broker as real LIMIT orders from Order review.'),
            ),
          ),
          !live
            ? badge('Checking', 'neutral')
            : live.serverEnabled
              ? badge('Available', 'caution')
              : badge('Off on this server', 'neutral'),
        ),
        cardContent(
          'space-y-4',
          !live
            ? statusLine(t('Checking live order availability…'))
            : !live.serverEnabled
              ? h(
                  'p',
                  { class: 'text-sm text-muted' },
                  'Live trading is turned off on this server. An administrator can enable it with LIVE_TRADING_ENABLED=true once Zerodha is configured. Until then, plans stay for review only.',
                )
              : [
                  h(
                    'div',
                    { class: 'max-w-sm' },
                    h(
                      'label',
                      {
                        for: 'live-order-broker',
                        class: 'mb-1.5 block text-xs font-medium text-muted',
                      },
                      t('Live order broker'),
                    ),
                    brokerPicker,
                  ),
                  live.enabled
                    ? null
                    : h(
                        'p',
                        {
                          role: 'note',
                          class: 'border border-caution bg-caution-soft px-3 py-2 text-sm text-fg',
                        },
                        `Connect ${live.broker.label} in Settings before placing live orders.`,
                      ),
                  h(
                    'dl',
                    { class: 'preference-ledger' },
                    h(
                      'div',
                      {},
                      h('dt', {}, 'Maximum order value'),
                      h('dd', {}, formatCurrency(live.maxOrderValue)),
                    ),
                    h(
                      'div',
                      {},
                      h('dt', {}, 'Maximum quantity'),
                      h('dd', {}, live.maxQuantity.toLocaleString('en-IN')),
                    ),
                    h(
                      'div',
                      {},
                      h('dt', {}, 'Orders per day'),
                      h('dd', {}, `${live.usedToday} of ${live.dailyLimit} used today`),
                    ),
                    h(
                      'div',
                      {},
                      h('dt', {}, 'Price check'),
                      h('dd', {}, `Within ${live.maxPriceDeviationPercent}% of the current price`),
                    ),
                  ),
                  live.mfaVerified
                    ? null
                    : h(
                        'p',
                        {
                          role: 'note',
                          class: 'border border-caution bg-caution-soft px-3 py-2 text-sm text-fg',
                        },
                        'Add and verify an authenticator (Authenticator security, above) before enabling live orders.',
                      ),
                  h(
                    'label',
                    { class: 'flex items-start gap-3 text-sm' },
                    toggle,
                    h(
                      'span',
                      {},
                      'Allow live orders from my reviewed plans. Each order still needs a typed confirmation.',
                    ),
                  ),
                  h(
                    'p',
                    { class: 'text-xs leading-5 text-muted' },
                    'Only the entry LIMIT order is sent; stops and targets are not placed automatically. Orders are sent only while the market is open, and each plan can be sent once. Real money is at risk.',
                  ),
                ],
          statusLine(state.message),
        ),
      ),
    );
  }
  paint();
  void load();
}
