/**
 * Admin → AI models: which OpenAI models answer analysis and quick requests
 * (moved here from the member Settings page). The API key itself is set in
 * Integrations.
 */
import { $, h, render } from '../core/dom.js';
import { mfaNotice } from './shared.js';
import { mountModelRouting } from '../pages/settings/ai.js';

render($('[data-admin-ai]'), mfaNotice(), h('div', { 'data-model-routing': '' }));
mountModelRouting(() => undefined);
