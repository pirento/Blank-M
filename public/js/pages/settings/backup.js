/** Settings page — data backup. */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  icon,
  button,
  buttonClass,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  render,
} from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { notify } from '../../core/toast.js';
import { available, cardDescription, errorLine } from './shared.js';

/**
 * Mounts the data backup card: a download link to /api/account/export and a restore that
 * uploads a JSON backup (optionally including settings) to /api/account/restore.
 */
export function mountBackup() {
  const state = { busy: false, summary: null, error: '' };
  const root = $('[data-backup]');
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'sr-only',
  });
  const includeSettings = h('input', { type: 'checkbox', class: 'mt-1' });
  const LABELS = {
    strategies: 'Strategies',
    trades: 'Trades',
    rules: 'Rules',
    watchlist: 'Watchlist',
    chatMessages: 'AI chat messages',
    orderPlans: 'Saved order plans',
    settings: 'Settings',
  };
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || state.busy) return;
    state.busy = true;
    state.summary = null;
    state.error = '';
    paint();
    try {
      const form = new FormData();
      form.append('includeSettings', includeSettings.checked ? 'true' : 'false');
      form.append('file', file);
      state.summary = (
        await api('/api/account/restore', { method: 'POST', form, timeout: 120_000 })
      ).summary;
      notify('Backup restored. Reload pages to see the restored records.', 'success');
    } catch (error) {
      state.error = errorMessage(error, 'The backup could not be restored.');
    } finally {
      state.busy = false;
      paint();
    }
  });
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
            cardTitle(t('Data backup')),
            cardDescription(
              t('Download everything in your account, or restore records from a backup file.'),
            ),
          ),
        ),
        cardContent(
          'space-y-4',
          h(
            'p',
            { class: 'text-sm text-muted' },
            'The backup is a JSON file with your trades, strategies, rules, watchlist, AI chat, saved plans, backtest evidence and settings. Chart screenshots are not included. Keep it private.',
          ),
          h(
            'div',
            { class: 'flex flex-wrap gap-2' },
            h(
              'a',
              { href: '/api/account/export', class: buttonClass('default'), download: '' },
              icon('download', 14, 'mr-2'),
              'Download backup',
            ),
            button(
              [icon('upload', 14, 'mr-2'), state.busy ? 'Restoring…' : 'Restore from backup'],
              {
                variant: 'outline',
                disabled: state.busy || !available,
                onclick: () => fileInput.click(),
              },
            ),
            fileInput,
          ),
          h(
            'label',
            { class: 'flex items-start gap-2 text-sm' },
            includeSettings,
            h(
              'span',
              {},
              'Also replace my planning capital and charge rates with the ones in the backup.',
            ),
          ),
          h(
            'p',
            { class: 'text-xs text-muted' },
            'Restoring only adds records. Nothing in your account is changed or deleted, and records already present are skipped, so restoring the same file twice is safe. Backtest evidence stays in the file as an archive.',
          ),
          state.error ? errorLine(state.error) : null,
          state.summary
            ? h(
                'dl',
                { class: 'preference-ledger' },
                Object.entries(state.summary).map(([section, value]) =>
                  h(
                    'div',
                    {},
                    h('dt', {}, LABELS[section] ?? section),
                    h(
                      'dd',
                      {},
                      `${value.added} added · ${value.skipped} already present${value.invalid ? ` · ${value.invalid} invalid` : ''}`,
                    ),
                  ),
                ),
              )
            : null,
        ),
      ),
    );
  }
  paint();
}
