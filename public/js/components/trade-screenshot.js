/**
 * Chart screenshot dialog for one journal trade: view, add, replace or remove
 * the image. `onChange(trade)` receives the updated trade after a change.
 */
import { t } from '../core/i18n.js';
import { h, button, buttonClass } from '../core/dom.js';
import { api } from '../core/api.js';
import { openModal } from '../core/dialog.js';
import { notify, notifyError } from '../core/toast.js';

const MAX_SIDE = 1600;

/**
 * A smaller copy of the image (longest side ≤ 1600 px, WebP) so a chart takes ~200 KB instead of a
 * few MB on the server. Falls back to the original file if the browser cannot convert it.
 */
async function shrinkImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
    // Browsers without WebP encoding return PNG, which may be larger: keep whichever is smaller.
    if (!blob || blob.size >= file.size) return file;
    const extension = blob.type === 'image/webp' ? 'webp' : 'png';
    return new File([blob], `chart.${extension}`, { type: blob.type });
  } catch {
    return file;
  }
}

/** Open the screenshot modal; uploads (POST) and removals (DELETE) go to /api/trades/:id/screenshot. */
export function openTradeScreenshot(trade, { onChange }) {
  openModal({
    title: `${trade.symbol} chart`,
    description: `${trade.date} · PNG, JPEG or WebP up to 5 MB (large images are made smaller).`,
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
        form.append('file', await shrinkImage(file));
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
