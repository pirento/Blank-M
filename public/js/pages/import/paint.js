/**
 * Renders the current import stage.
 */
import { $, h, button, render } from '../../core/dom.js';
import { batchCard, chooseCard } from './cards.js';
import { mappingSection } from './mapping.js';
import { reset } from './reading.js';
import { recoveryError, state } from './shared.js';

/** Repaints the import page for the current stage: saved import, error, file chooser or mapping. */
export function paint() {
  render(
    $('[data-head-actions]'),
    state.stage === 'map'
      ? button('Choose a different file', {
          variant: 'outline',
          disabled: state.importing || Boolean(state.batch),
          onclick: reset,
        })
      : null,
  );
  render(
    $('[data-import-root]'),
    state.batch ? batchCard() : null,
    state.importError
      ? h(
          'p',
          { role: recoveryError ? 'alert' : 'status', class: 'text-sm text-negative' },
          state.importError,
        )
      : null,
    state.stage === 'choose' && !state.batch
      ? chooseCard()
      : state.stage === 'map'
        ? mappingSection()
        : null,
  );
}
