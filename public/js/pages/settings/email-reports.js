/** Settings page — email reports. */
import { t } from '../../core/i18n.js';
import { $, h, button, card, cardHeader, cardTitle, cardContent, render } from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { cardDescription, data, statusLine } from './shared.js';

/**
 * Mounts the email reports card: toggles the weekly report email and its AI coach review
 * via /api/account/notifications, and can send the weekly report now.
 */
export function mountEmailReports() {
  const state = {
    loading: true,
    enabled: false,
    coach: false,
    aiConfigured: Boolean(data.health?.aiAvailable),
    configured: Boolean(data.health?.email),
    busy: false,
    message: '',
  };
  const root = $('[data-email-reports]');
  async function load() {
    try {
      const result = await api('/api/account/notifications');
      state.enabled = result.weeklyReportEmail;
      state.coach = result.weeklyAiCoach;
      state.configured = result.emailConfigured;
      state.aiConfigured = result.aiConfigured;
    } catch (error) {
      state.message = errorMessage(error, 'Email report settings could not be loaded.');
    } finally {
      state.loading = false;
      paint();
    }
  }
  async function act(action) {
    if (state.busy) return;
    state.busy = true;
    state.message = '';
    paint();
    try {
      state.message = await action();
    } catch (error) {
      state.message = errorMessage(error, 'Could not update email reports.');
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
      disabled: state.loading || state.busy || (!state.configured && !state.enabled),
    });
    toggle.addEventListener(
      'change',
      () =>
        void act(async () => {
          const result = await api('/api/account/notifications', {
            method: 'PUT',
            body: { weeklyReportEmail: toggle.checked },
          });
          state.enabled = result.weeklyReportEmail;
          return state.enabled ? 'Weekly report emails are on.' : 'Weekly report emails are off.';
        }),
    );
    const coachToggle = h('input', {
      type: 'checkbox',
      class: 'mt-1 h-4 w-4 accent-accent',
      checked: state.coach,
      disabled:
        state.loading || state.busy || !state.enabled || (!state.aiConfigured && !state.coach),
    });
    coachToggle.addEventListener(
      'change',
      () =>
        void act(async () => {
          const result = await api('/api/account/notifications', {
            method: 'PUT',
            body: { weeklyAiCoach: coachToggle.checked },
          });
          state.coach = result.weeklyAiCoach;
          return state.coach
            ? 'The weekly email will include an AI coach review.'
            : 'The weekly email will not include an AI coach review.';
        }),
    );
    render(
      root,
      card(
        {},
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('Email reports')),
            cardDescription(
              `A summary of last week's journal, sent to ${data.email || 'your email'} every Monday.`,
            ),
          ),
        ),
        cardContent(
          'space-y-4',
          state.configured
            ? null
            : h(
                'p',
                {
                  role: 'note',
                  class: 'border border-caution bg-caution-soft px-3 py-2 text-sm text-fg',
                },
                'Email delivery is not configured on this server, so report emails cannot be sent yet.',
              ),
          h(
            'label',
            { class: 'flex items-start gap-3 text-sm' },
            toggle,
            h('span', {}, 'Email me a weekly report (Monday–Sunday, IST)'),
          ),
          h(
            'label',
            { class: 'flex items-start gap-3 text-sm' },
            coachToggle,
            h(
              'span',
              {},
              'Include an AI coach review of the week',
              h(
                'span',
                { class: 'block text-xs text-muted' },
                state.aiConfigured
                  ? 'Uses your trades, tags and rules; counts toward your AI usage.'
                  : 'AI is not configured on this server.',
              ),
            ),
          ),
          button(state.busy ? 'Sending…' : "Send last week's report now", {
            variant: 'outline',
            disabled: state.busy || state.loading || !state.configured,
            onclick: () =>
              void act(async () => {
                const result = await api('/api/account/weekly-report/send', {
                  method: 'POST',
                  body: {},
                  timeout: 60_000,
                });
                return `Report for the week starting ${result.week} was sent.`;
              }),
          }),
          statusLine(state.message),
        ),
      ),
    );
  }
  paint();
  void load();
}
