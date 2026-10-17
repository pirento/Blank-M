/**
 * Settings page — read-only links for a mentor. A new link's URL is shown once
 * (copy it then); links expire after 7, 30 or 90 days and can be revoked.
 */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  button,
  input,
  label,
  select,
  badge,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  formatIstDateTime,
  render,
  errorLine,
} from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { notify, notifyError } from '../../core/toast.js';
import { cardDescription, statusLine } from './shared.js';

/**
 * Mounts the mentor share links card: creates read-only links (7/30/90 days, notes
 * optional), lists them and revokes them via /api/share-links.
 */
export function mountShareLinks() {
  const root = $('[data-share-links]');
  if (!root) return;
  const state = { links: [], loading: true, busy: false, error: '', created: null };
  const labelField = input({ id: 'share-label', maxlength: '80', placeholder: t('For my mentor') });
  const daysField = select({ id: 'share-days' }, [
    { value: '7', label: '7 days' },
    { value: '30', label: '30 days', selected: true },
    { value: '90', label: '90 days' },
  ]);
  const notesField = h('input', {
    type: 'checkbox',
    id: 'share-notes',
    class: 'h-4 w-4 accent-accent',
  });

  async function load() {
    try {
      state.links = (await api('/api/share-links')).links;
      state.error = '';
    } catch (error) {
      state.error = errorMessage(error, 'Share links could not be loaded.');
    } finally {
      state.loading = false;
      paint();
    }
  }

  async function create() {
    if (state.busy) return;
    state.busy = true;
    paint();
    try {
      const result = await api('/api/share-links', {
        method: 'POST',
        body: {
          label: labelField.value,
          days: Number(daysField.value),
          includeNotes: notesField.checked,
        },
      });
      state.created = result.url;
      labelField.value = '';
      await load();
    } catch (error) {
      state.error = errorMessage(error, 'The link could not be created.');
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function revoke(link) {
    try {
      await api(`/api/share-links/${encodeURIComponent(link.id)}/revoke`, { method: 'POST' });
      notify('Link revoked. It no longer opens.', 'success');
      await load();
    } catch (error) {
      notifyError(error, 'The link could not be revoked.');
    }
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
            cardTitle(t('Share with a mentor')),
            cardDescription(
              t(
                'A read-only link to your trades, P&L calendar, mistakes and setups. Capital, balances, plans and chat are never shared.',
              ),
            ),
          ),
        ),
        cardContent(
          'space-y-4',
          h(
            'div',
            { class: 'grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end' },
            h('div', { class: 'space-y-1' }, label(t('Label'), labelField.id), labelField),
            h('div', { class: 'space-y-1' }, label(t('Expires after'), daysField.id), daysField),
            button(state.busy ? 'Creating…' : 'Create link', {
              disabled: state.busy,
              onclick: () => void create(),
            }),
          ),
          h(
            'label',
            { class: 'flex items-center gap-2 text-sm', for: notesField.id },
            notesField,
            'Include trade notes',
          ),
          state.created
            ? h(
                'div',
                { class: 'space-y-2 rounded-control border border-accent p-3' },
                h('p', { class: 'text-sm text-fg' }, 'Copy this link now — it is shown only once.'),
                h(
                  'div',
                  { class: 'flex flex-wrap gap-2' },
                  input({
                    id: 'share-created-url',
                    value: state.created,
                    readonly: true,
                    class: 'min-w-0 flex-1',
                  }),
                  button(t('Copy'), {
                    variant: 'outline',
                    onclick: async () => {
                      try {
                        await navigator.clipboard.writeText(state.created);
                        notify('Link copied.', 'success');
                      } catch {
                        notify('Select the link and copy it.', 'info');
                      }
                    },
                  }),
                ),
              )
            : null,
          state.error ? errorLine(state.error) : null,
          state.loading
            ? statusLine(t('Loading links…'))
            : state.links.length
              ? h(
                  'ul',
                  { class: 'space-y-2' },
                  state.links.map((link) =>
                    h(
                      'li',
                      {
                        class:
                          'flex flex-wrap items-center justify-between gap-2 rounded-control border border-line p-3 text-sm',
                      },
                      h(
                        'div',
                        { class: 'min-w-0' },
                        h('span', { class: 'font-medium text-fg' }, link.label || 'Untitled link'),
                        h(
                          'span',
                          { class: 'ml-2' },
                          badge(link.status, link.status === 'active' ? 'positive' : 'neutral'),
                        ),
                        h(
                          'div',
                          { class: 'text-xs text-muted' },
                          `Expires ${formatIstDateTime(link.expiresAt)} IST · ${link.viewCount} views${link.includeNotes ? ' · notes included' : ''}`,
                        ),
                      ),
                      link.status === 'active'
                        ? button(t('Revoke'), {
                            variant: 'ghost',
                            size: 'sm',
                            className: 'text-negative',
                            'aria-label': `Revoke ${link.label || 'the untitled'} link`,
                            onclick: () => void revoke(link),
                          })
                        : null,
                    ),
                  ),
                )
              : h('p', { class: 'text-sm text-muted' }, 'No links yet.'),
        ),
      ),
    );
  }
  paint();
  void load();
}
