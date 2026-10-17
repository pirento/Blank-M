/** Settings page — Blank AI. */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  icon,
  button,
  label,
  select,
  badge,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  render,
} from '../../core/dom.js';
import { api } from '../../core/api.js';
import { notify, notifyError } from '../../core/toast.js';
import { requestSymbol } from '../../lib/ai.js';
import { cardDescription, data, plainFact, statusLine } from './shared.js';

function fact(iconName, text, value) {
  return h(
    'div',
    { class: 'rounded-control border border-line bg-elevated p-3' },
    icon(iconName, 15, 'text-accent'),
    h('p', { class: 'mt-2 text-xs text-subtle' }, text),
    h('p', { class: 'mt-0.5 truncate text-sm font-medium text-fg' }, value),
  );
}

/**
 * Mounts the Blank AI card: shows whether OpenAI is configured (from /api/health) and a
 * test button that sends a small symbol lookup. Returns the health reload function.
 */
export function mountAi() {
  const state = { health: null, testing: false, result: null };
  const aiAvailable = () => Boolean(state.health?.integrations?.openai ?? data.health?.aiAvailable);
  async function loadHealth() {
    try {
      state.health = await api('/api/health');
    } catch {
      state.health = null;
    }
    paint();
  }
  function paint() {
    const health = state.health;
    render(
      $('[data-ai]'),
      card(
        {},
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('Blank AI')),
            cardDescription(
              t('OpenAI runs server-side. No API credential is stored in your browser.'),
            ),
          ),
          !health
            ? badge('Checking', 'neutral')
            : aiAvailable()
              ? badge('Configured', 'positive')
              : badge('Unavailable', 'caution'),
        ),
        cardContent(
          'space-y-4',
          h(
            'p',
            { class: 'text-sm text-muted' },
            'Configuration does not verify provider access or billing. Testing sends a small paid request to OpenAI.',
          ),
          h(
            'div',
            { class: 'grid gap-3 sm:grid-cols-2' },
            fact('brain-circuit', 'Analysis model', health?.model ?? '—'),
            fact('sparkles', 'Fast model', health?.fastModel ?? '—'),
            fact('shield-check', 'Credential policy', 'Server only'),
            fact('shield-check', 'Build', health?.commit ?? '—'),
          ),
          button([icon('sparkles', 14, 'mr-2'), state.testing ? 'Testing…' : 'Test OpenAI'], {
            variant: 'outline',
            disabled: state.testing || !aiAvailable(),
            onclick: async () => {
              state.testing = true;
              state.result = null;
              paint();
              try {
                const symbol = await requestSymbol('Reliance Industries');
                state.result = `OpenAI is responding${symbol ? ` — RELIANCE resolved as ${symbol}` : ''}.`;
              } catch (error) {
                state.result = error instanceof Error ? error.message : 'The OpenAI check failed.';
              } finally {
                state.testing = false;
                paint();
              }
            },
          }),
          state.result
            ? h(
                'p',
                {
                  class:
                    'rounded-control border border-line bg-elevated px-3 py-2 text-sm text-muted',
                },
                state.result,
              )
            : null,
        ),
      ),
    );
  }
  paint();
  void loadHealth();
  return loadHealth;
}

/**
 * Admin only: mounts the OpenAI model routing card, which loads and saves the analysis/fast
 * models via /api/admin/ai/config and can test them. Saving calls `refreshHealth`.
 */
export function mountModelRouting(refreshHealth) {
  if (data.role !== 'admin') return;
  const state = { config: null, loaded: false, saving: false, testing: false };
  async function load() {
    try {
      state.config = await api('/api/admin/ai/config');
    } catch {
      state.config = null;
    }
    state.loaded = true;
    paint();
  }
  const body = () => ({
    analysisModel: state.config.analysisModel,
    fastModel: state.config.fastModel,
  });
  function paint() {
    const config = state.config;
    let content;
    if (!state.loaded) content = statusLine(t('Loading model routing…'));
    else if (!config) {
      content = h(
        'div',
        { class: 'space-y-2' },
        h(
          'p',
          { class: 'text-sm text-muted' },
          'Model routing could not be loaded. Verify your administrator session and server setup.',
        ),
        button(t('Recheck administrator session'), {
          variant: 'outline',
          onclick: () => void load(),
        }),
      );
    } else {
      const analysis = select(
        { id: 'analysis-model' },
        config.allowedAnalysisModels.map((value) => ({
          value,
          label: value,
          selected: value === config.analysisModel,
        })),
      );
      analysis.addEventListener('change', () => (config.analysisModel = analysis.value));
      const fast = select(
        { id: 'fast-model' },
        config.allowedFastModels.map((value) => ({
          value,
          label: value,
          selected: value === config.fastModel,
        })),
      );
      fast.addEventListener('change', () => (config.fastModel = fast.value));
      content = [
        h(
          'div',
          { class: 'grid gap-4 md:grid-cols-2' },
          h(
            'div',
            {},
            label(t('Analysis and vision'), 'analysis-model'),
            analysis,
            h(
              'p',
              { class: 'mt-1.5 text-xs text-subtle' },
              'Chat, briefings, reviews, reports, statements and charts.',
            ),
          ),
          h(
            'div',
            {},
            label(t('Fast structured tasks'), 'fast-model'),
            fast,
            h('p', { class: 'mt-1.5 text-xs text-subtle' }, 'Symbol resolution and rule drafting.'),
          ),
        ),
        h(
          'div',
          { class: 'grid gap-3 rounded-card border border-line bg-elevated p-4 sm:grid-cols-2' },
          plainFact('Voice transcription', config.transcriptionModel),
          plainFact('Private journal search', config.embeddingModel),
        ),
        h(
          'div',
          { class: 'flex flex-wrap gap-2' },
          button([icon('save', 14, 'mr-2'), state.saving ? 'Saving…' : 'Save model routing'], {
            disabled: state.saving,
            onclick: async () => {
              state.saving = true;
              paint();
              try {
                state.config = await api('/api/admin/ai/config', { method: 'PUT', body: body() });
                void refreshHealth();
                notify('OpenAI model routing updated.', 'success');
              } catch (error) {
                notifyError(error, 'Could not update model routing.');
              } finally {
                state.saving = false;
                paint();
              }
            },
          }),
          button(
            [icon('sparkles', 14, 'mr-2'), state.testing ? 'Testing…' : 'Test selected models'],
            {
              variant: 'outline',
              disabled: state.testing,
              onclick: async () => {
                state.testing = true;
                paint();
                try {
                  const result = await api('/api/admin/ai/test', {
                    method: 'POST',
                    body: body(),
                    timeout: 120_000,
                  });
                  if (result?.ok !== true) throw new Error('One or more selected models failed.');
                  notify('Both selected OpenAI models responded correctly.', 'success');
                } catch (error) {
                  notifyError(error, 'One or more selected models failed.');
                } finally {
                  state.testing = false;
                  paint();
                }
              },
            },
          ),
        ),
      ];
    }
    render(
      $('[data-model-routing]'),
      card(
        {},
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('OpenAI model routing')),
            cardDescription(
              t(
                'Choose approved models by workload. The API key remains server-only and is never returned to this page.',
              ),
            ),
          ),
          badge('Administrator', 'accent'),
        ),
        cardContent('space-y-5', content),
      ),
    );
  }
  paint();
  void load();
}
