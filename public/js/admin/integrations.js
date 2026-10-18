/**
 * Admin → Integrations: every API key and switch from services/platform/settings-registry.js,
 * one card per group. Each field shows where its value comes from (this panel,
 * the server's .env, or not set). Secrets are never sent to the browser: their
 * box stays empty and shows the last four characters; type a new value to
 * replace it. "Use .env value" removes the panel value.
 */
import {
  $,
  h,
  render,
  button,
  input,
  label,
  statusLine,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  badge,
} from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { notify } from '../core/toast.js';
import { mfaNotice, when } from './shared.js';

const root = $('[data-admin-integrations]');
let groups = [];

const SOURCE = {
  panel: ['Set in admin panel', 'positive'],
  env: ['From .env', 'neutral'],
  unset: ['Not set', 'caution'],
};

/** One form control for a setting; returns { element, read() → value | undefined (unchanged) }. */
function control(setting) {
  const id = `setting-${setting.key}`;
  if (setting.type === 'boolean') {
    const box = h('input', {
      id,
      type: 'checkbox',
      class: 'h-4 w-4 accent-accent',
      checked: setting.value === 'true',
    });
    const initial = box.checked;
    return {
      element: h(
        'label',
        { class: 'flex items-center gap-2 text-sm', for: id },
        box,
        setting.label,
      ),
      read: () => (box.checked === initial ? undefined : box.checked),
    };
  }
  const secret = setting.type === 'secret';
  const field = input({
    id,
    type: secret ? 'password' : setting.type === 'number' ? 'number' : 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    value: secret ? '' : (setting.value ?? ''),
    placeholder: secret
      ? setting.hint
        ? `Saved · ends with ${setting.hint} — type to replace`
        : setting.source === 'unset'
          ? 'Not set'
          : 'Saved — type to replace'
      : '',
    ...(setting.min !== null ? { min: String(setting.min) } : {}),
    ...(setting.max !== null ? { max: String(setting.max) } : {}),
  });
  const initial = field.value;
  return {
    element: h('div', {}, label(setting.label, id), field),
    // An empty secret box means "keep the saved value".
    read: () =>
      secret ? field.value.trim() || undefined : field.value === initial ? undefined : field.value,
  };
}

async function save(changes, message) {
  try {
    groups = (await api('/api/admin/settings', { method: 'PUT', body: { changes } })).groups;
    notify(message, 'success');
    paint();
  } catch (error) {
    notify(errorMessage(error, 'The settings could not be saved.'), 'error');
  }
}

function groupCard(group) {
  const controls = group.settings.map((setting) => ({ setting, ...control(setting) }));
  return card(
    {},
    cardHeader('', cardTitle(group.group)),
    cardContent(
      'space-y-4',
      ...controls.map(({ setting, element }) =>
        h(
          'div',
          { class: 'space-y-1' },
          element,
          h(
            'div',
            { class: 'flex flex-wrap items-center gap-2 text-xs text-muted' },
            badge(...SOURCE[setting.source]),
            setting.updatedAt ? h('span', {}, `changed ${when(setting.updatedAt)}`) : null,
            setting.source === 'panel'
              ? button('Use .env value', {
                  variant: 'ghost',
                  size: 'sm',
                  onclick: () =>
                    void save({ [setting.key]: '' }, `${setting.label}: back to the .env value.`),
                })
              : null,
          ),
          setting.help ? h('p', { class: 'text-xs text-subtle' }, setting.help) : null,
        ),
      ),
      button(`Save ${group.group}`, {
        onclick: () => {
          const changes = {};
          for (const { setting, read } of controls) {
            const value = read();
            if (value !== undefined) changes[setting.key] = value;
          }
          if (!Object.keys(changes).length) return notify('Nothing changed.', 'info');
          void save(changes, `${group.group} saved.`);
        },
      }),
    ),
  );
}

function paint() {
  render(
    root,
    mfaNotice(),
    h(
      'p',
      { class: 'mb-4 text-sm text-muted' },
      'Values saved here replace the ones in the server .env file and take effect within a minute — no restart needed. Database address, session secret, encryption key, cron secret and app URL can only be changed in .env.',
    ),
    h('div', { class: 'grid gap-4 lg:grid-cols-2' }, ...groups.map(groupCard)),
  );
}

async function load() {
  render(root, statusLine('Loading…'));
  try {
    groups = (await api('/api/admin/settings')).groups;
    paint();
  } catch (error) {
    render(
      root,
      statusLine(
        errorMessage(error, 'Settings could not be loaded.'),
        'alert',
        'text-sm text-negative',
      ),
    );
  }
}

void load();
