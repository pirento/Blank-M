/**
 * Notices shown instead of AI controls when the server has no OpenAI key.
 */
import { h, icon } from '../core/dom.js';

/** Shown in place of an AI control when the server has no OpenAI configuration. */
export function aiUnavailableNotice(feature) {
  return h(
    'div',
    { class: 'rounded-card border border-caution/40 bg-caution-soft p-4' },
    h(
      'div',
      { class: 'flex items-start gap-3' },
      icon('sparkles', 18, 'mt-0.5 shrink-0 text-caution'),
      h(
        'div',
        {},
        h('p', { class: 'text-sm font-medium text-fg' }, `${feature} is temporarily unavailable`),
        h(
          'p',
          { class: 'mt-1 text-sm text-muted' },
          'The secure OpenAI service is not configured on this deployment. Contact your workspace administrator; personal API keys are never stored in the browser.',
        ),
      ),
    ),
  );
}

/** Replace `element` with the notice when AI is unavailable. */
export function aiGate(health, feature, element) {
  return health?.aiAvailable ? element : aiUnavailableNotice(feature);
}
