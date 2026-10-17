/**
 * Chart screenshot dialog for one journal trade: view, add, replace or remove
 * the image. `onChange(trade)` receives the updated trade after a change.
 */
import { t } from '../core/i18n.js';
import { h, button, buttonClass } from '../core/dom.js';
import { api } from '../core/api.js';
import { openModal } from '../core/dialog.js';
import { notify, notifyError } from '../core/toast.js';

/** Open the screenshot modal; uploads (POST) and removals (DELETE) go to /api/trades/:id/screenshot. */
export function openTradeScreenshot(trade, { onChange }) {
  openModal({
    title: `${trade.symbol} chart`,
    description: `${trade.date} · PNG, JPEG or WebP up to 5 MB.`,
    content: (close) => {
      let busy = false;
      const status = h('p', { role: 'status', class: 'text-sm text-muted' });
      const fileInput = h('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/webp',
        class: 'sr-only',
        id: `shot-${trade.id.slice(0, 8)}`,
      });
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file || busy) return;
        busy = true;
        status.textContent = 'Uploading…';
        const form = new FormData();
        form.append('file', file);
        try {
          const result = await api(`/api/trades/${encodeURIComponent(trade.id)}/screenshot`, {
            method: 'POST',
            form,
            timeout: 60_000,
          });
          onChange(result.trade);
          notify('Screenshot saved.', 'success');
          close();
        } catch (error) {
          status.textContent = '';
          notifyError(error, 'Could not save the screenshot.');
        } finally {
          busy = false;
        }
      });
      return h(
        'div',
        { class: 'space-y-4' },
        trade.hasScreenshot
          ? h('img', {
              src: `/api/trades/${encodeURIComponent(trade.id)}/screenshot`,
              alt: `Chart screenshot for the ${trade.symbol} trade on ${trade.date}`,
              class: 'max-h-[60vh] w-full rounded-control border border-line object-contain',
            })
          : h('p', { class: 'text-sm text-muted' }, 'No screenshot yet.'),
        status,
        h(
          'div',
          { class: 'flex flex-wrap gap-2' },
          fileInput,
          h(
            'label',
            { for: fileInput.id, class: buttonClass('outline') },
            trade.hasScreenshot ? 'Replace image' : 'Choose image',
          ),
          trade.hasScreenshot
            ? button(t('Remove'), {
                variant: 'ghost',
                className: 'text-negative',
                onclick: async () => {
                  if (busy) return;
                  busy = true;
                  try {
                    const result = await api(
                      `/api/trades/${encodeURIComponent(trade.id)}/screenshot`,
                      { method: 'DELETE' },
                    );
                    onChange(result.trade);
                    notify('Screenshot removed.', 'success');
                    close();
                  } catch (error) {
                    notifyError(error, 'Could not remove the screenshot.');
                  } finally {
                    busy = false;
                  }
                },
              })
            : null,
        ),
      );
    },
  });
}
