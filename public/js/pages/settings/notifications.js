/**
 * Settings page — notifications on this device and app install. Turning
 * notifications on asks the browser for permission and registers this device
 * for push (price alerts); each device is turned on separately.
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

/** VAPID public keys are base64url; PushManager wants the raw bytes. */
function keyBytes(base64url) {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

let installPrompt = null;
let repaint = null;
// Chrome offers installation through this event; keep it for the Install button.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  repaint?.();
});

/**
 * Mounts the push notifications card: subscribes or unsubscribes this device through the
 * service worker and /api/push/*, and sends a test notification.
 */
export function mountNotifications() {
  const root = $('[data-notifications]');
  if (!root) return;
  const supported =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const state = { config: null, subscription: null, busy: false, error: '' };

  async function load() {
    try {
      state.config = await api('/api/push');
      if (supported) {
        const registration = await navigator.serviceWorker.getRegistration();
        state.subscription = (await registration?.pushManager.getSubscription()) ?? null;
      }
    } catch (error) {
      state.error = errorMessage(error, 'Notification settings could not be loaded.');
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

  const turnOn = () =>
    run(async () => {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error(
          'Notifications are blocked for this site. Allow them in the browser settings.',
        );
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(state.config.publicKey),
      });
      const result = await api('/api/push/subscribe', {
        method: 'POST',
        body: { subscription: subscription.toJSON() },
      });
      state.subscription = subscription;
      state.config.devices = result.devices;
      notify('Notifications are on for this device.', 'success');
    });

  const turnOff = () =>
    run(async () => {
      const endpoint = state.subscription.endpoint;
      await state.subscription.unsubscribe();
      const result = await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint } });
      state.subscription = null;
      state.config.devices = result.devices;
      notify('Notifications are off for this device.', 'success');
    });

  const test = () =>
    run(async () => {
      await api('/api/push/test', { method: 'POST' });
      notify('Test notification sent.', 'success');
    });

  const install = () =>
    run(async () => {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
    });

  function paint() {
    const config = state.config;
    const message = !supported
      ? 'This browser cannot receive push notifications. On iPhone, add Blank to the Home Screen first.'
      : !config
        ? 'Loading…'
        : !config.configured
          ? 'Push notifications are not configured on this server (VAPID keys).'
          : state.subscription
            ? `Notifications are on for this device (${config.devices} ${config.devices === 1 ? 'device' : 'devices'} in total).`
            : 'Notifications are off for this device.';
    render(
      root,
      card(
        {},
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('Notifications & app')),
            cardDescription(
              t('Get price alerts on this phone or computer, and install Blank as an app.'),
            ),
          ),
        ),
        cardContent(
          'space-y-4',
          statusLine(message),
          state.error ? errorLine(state.error) : null,
          h(
            'div',
            { class: 'flex flex-wrap gap-2' },
            supported && config?.configured && !state.subscription
              ? button(t('Turn on notifications'), {
                  disabled: state.busy,
                  onclick: () => void turnOn(),
                })
              : null,
            state.subscription
              ? [
                  button(t('Send test'), {
                    variant: 'outline',
                    disabled: state.busy,
                    onclick: () => void test(),
                  }),
                  button(t('Turn off on this device'), {
                    variant: 'ghost',
                    disabled: state.busy,
                    onclick: () => void turnOff(),
                  }),
                ]
              : null,
            installPrompt
              ? button(t('Install app'), {
                  variant: 'outline',
                  disabled: state.busy,
                  onclick: () => void install(),
                })
              : null,
          ),
          h(
            'p',
            { class: 'text-xs leading-5 text-muted' },
            installPrompt
              ? 'Installing adds Blank to your home screen or app list; it opens in its own window.'
              : 'To install: use “Install app” or “Add to Home Screen” in the browser menu.',
          ),
        ),
      ),
    );
  }
  repaint = paint;
  paint();
  void load();
}
