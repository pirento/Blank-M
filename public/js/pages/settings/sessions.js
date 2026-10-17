/** Settings page — signed-in devices. */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  button,
  badge,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  render,
} from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { notify, notifyError } from '../../core/toast.js';
import { cardDescription, errorLine, statusLine } from './shared.js';

const when = (value) =>
  value
    ? new Date(value).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';

/** Mounts the signed-in devices card: lists sessions and revokes one or all other sessions. */
export function mountSessions() {
  const state = { sessions: [], loading: true, busy: false, error: '' };
  const root = $('[data-sessions]');
  async function load() {
    state.loading = true;
    state.error = '';
    paint();
    try {
      state.sessions = (await api('/api/account/sessions')).sessions;
    } catch (error) {
      state.error = errorMessage(error, 'Signed-in devices could not be loaded.');
    } finally {
      state.loading = false;
      paint();
    }
  }
  async function run(action, success, failure) {
    if (state.busy) return;
    state.busy = true;
    paint();
    try {
      await action();
      notify(success, 'success');
      state.busy = false;
      await load();
    } catch (error) {
      notifyError(error, failure);
    } finally {
      state.busy = false;
      paint();
    }
  }
  function paint() {
    const others = state.sessions.filter((session) => !session.current);
    render(
      root,
      card(
        {},
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('Signed-in devices')),
            cardDescription(
              t(
                'Every browser where your account is signed in. Sign out any you do not recognise.',
              ),
            ),
          ),
        ),
        cardContent(
          'space-y-4',
          state.loading
            ? statusLine(t('Loading signed-in devices…'))
            : state.sessions.map((session) =>
                h(
                  'div',
                  {
                    class:
                      'flex flex-wrap items-center justify-between gap-3 rounded-control border border-line p-3',
                  },
                  h(
                    'div',
                    { class: 'min-w-0 text-sm' },
                    h(
                      'p',
                      { class: 'flex flex-wrap items-center gap-2' },
                      session.device,
                      session.current ? badge('This device', 'accent') : null,
                    ),
                    h(
                      'p',
                      { class: 'text-xs text-muted' },
                      `${session.method} sign-in ${when(session.signedInAt)} · last active ${when(session.lastActiveAt)} IST`,
                    ),
                  ),
                  session.current
                    ? null
                    : button(t('Sign out'), {
                        variant: 'outline',
                        size: 'sm',
                        disabled: state.busy,
                        onclick: () =>
                          void run(
                            () =>
                              api('/api/account/sessions/revoke', {
                                method: 'POST',
                                body: { sessionId: session.id },
                              }),
                            'That device was signed out.',
                            'Could not sign out that device.',
                          ),
                      }),
                ),
              ),
          state.error ? errorLine(state.error) : null,
          h(
            'div',
            { class: 'flex flex-wrap gap-2' },
            button(t('Sign out all other devices'), {
              variant: 'outline',
              disabled: state.busy || state.loading || others.length === 0,
              onclick: () =>
                void run(
                  () => api('/api/account/sessions/revoke-others', { method: 'POST', body: {} }),
                  'All other devices were signed out.',
                  'Could not sign out the other devices.',
                ),
            }),
            button(t('Refresh'), {
              variant: 'ghost',
              disabled: state.busy || state.loading,
              onclick: () => void load(),
            }),
          ),
        ),
      ),
    );
  }
  void load();
}
