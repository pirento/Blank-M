/**
 * Admin → Audit log: every change made in the admin panel, newest first, with
 * "Load older" paging. Secret values are never logged, only that they changed.
 */
import { $, h, render, button, statusLine } from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { when } from './shared.js';

const root = $('[data-admin-audit]');
const entries = [];
let finished = false;

const ACTIONS = {
  'setting.update': 'Changed setting',
  'setting.clear': 'Reset setting to .env',
  'billing.plan': 'Saved Premium plan',
  'member.grant': 'Gave Premium',
  'member.grant.end': 'Ended Premium grant',
};

function details(entry) {
  if (!entry.details) return '';
  return Object.entries(entry.details)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    .join(' · ');
}

function paint() {
  render(
    root,
    entries.length
      ? h(
          'ol',
          { class: 'divide-y divide-line rounded-card border border-line bg-surface' },
          ...entries.map((entry) =>
            h(
              'li',
              { class: 'px-4 py-3 text-sm' },
              h(
                'div',
                { class: 'flex flex-wrap justify-between gap-2' },
                h(
                  'strong',
                  { class: 'font-semibold text-fg' },
                  `${ACTIONS[entry.action] ?? entry.action} · ${entry.target}`,
                ),
                h(
                  'time',
                  { class: 'text-xs text-muted', datetime: entry.createdAt },
                  when(entry.createdAt),
                ),
              ),
              h(
                'p',
                { class: 'mt-1 break-words text-xs text-muted' },
                `by ${entry.actorEmail || 'unknown'}${details(entry) ? ` — ${details(entry)}` : ''}`,
              ),
            ),
          ),
        )
      : statusLine('No admin changes yet.'),
    finished
      ? null
      : h(
          'div',
          { class: 'mt-4' },
          button('Load older', { variant: 'outline', onclick: () => void load() }),
        ),
  );
}

async function load() {
  try {
    const before = entries.at(-1)?.createdAt;
    const page = (
      await api(`/api/admin/audit${before ? `?before=${encodeURIComponent(before)}` : ''}`)
    ).entries;
    entries.push(...page);
    finished = page.length < 100;
    paint();
  } catch (error) {
    render(
      root,
      statusLine(
        errorMessage(error, 'The audit log could not be loaded.'),
        'alert',
        'text-sm text-negative',
      ),
    );
  }
}

void load();
