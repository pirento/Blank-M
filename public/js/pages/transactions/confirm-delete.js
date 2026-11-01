import { t } from '../../core/i18n.js';
import { h, button } from '../../core/dom.js';
import { openModal } from '../../core/dialog.js';

/**
 * A delete confirmation: `run` does the deletion (and reports its own outcome), then the dialog
 * closes and `onDone` redraws the ledger. While it runs, neither button can be pressed again.
 */
export function confirmDelete({ title, text, confirmLabel, run, onDone }) {
  let busy = false;
  openModal({
    title,
    content: (close) => {
      const cancel = button(t('Cancel'), {
        variant: 'outline',
        className: 'flex-1',
        onclick: () => !busy && close(),
      });
      const confirm = button(confirmLabel, { variant: 'destructive', className: 'flex-1' });
      confirm.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        cancel.disabled = true;
        confirm.disabled = true;
        confirm.textContent = 'Deleting…';
        try {
          await run();
        } finally {
          busy = false;
          close();
          onDone();
        }
      });
      return h(
        'div',
        {},
        h('p', { class: 'mb-6 text-sm text-muted' }, text),
        h('div', { class: 'flex gap-4' }, cancel, confirm),
      );
    },
  });
}
