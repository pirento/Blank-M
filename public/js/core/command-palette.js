/**
 * Command palette (⌘K / Ctrl K) and keyboard shortcuts: "g" then a letter to
 * jump to a page, "n" to log a trade and "?" for the shortcut sheet.
 */
import { t } from './i18n.js';
import { h, icon, cn } from './dom.js';
import { openDialog } from './dialog.js';
import { currentTheme, toggleTheme } from './theme.js';

const NAV = JSON.parse(document.getElementById('nav-data')?.textContent || '[]');

/* ------------------------------- command palette ------------------------------ */

/** Case-insensitive subsequence match, so "bck" finds "Backtest". */
export function matches(query, labelText) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = labelText.toLowerCase();
  let index = 0;
  for (const character of needle) {
    index = haystack.indexOf(character, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

const GOTO_KEYS = {
  d: '/dashboard',
  j: '/journal',
  t: '/transactions',
  w: '/watchlist',
  r: '/reports',
  b: '/backtest',
  a: '/analytics',
  s: '/settings',
};

const SHORTCUTS = [
  { keys: '⌘K / Ctrl K', description: t('Open the command palette') },
  { keys: 'g then d', description: t('Dashboard') },
  { keys: 'g then j', description: t('Journal') },
  { keys: 'g then t', description: t('Transactions') },
  { keys: 'g then w', description: t('Watchlist') },
  { keys: 'g then r', description: t('Reports') },
  { keys: 'g then b', description: t('Backtest') },
  { keys: 'g then a', description: t('AI Analyst') },
  { keys: 'g then s', description: t('Settings') },
  { keys: 'n', description: t('Log a new trade') },
  { keys: '?', description: t('Show this sheet') },
];

let paletteOpen = null;
let shortcutsOpen = null;

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    Boolean(target.closest('[contenteditable="true"], [role="textbox"]')) ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  );
}

function commands() {
  const dark = currentTheme() === 'dark';
  return [
    ...NAV.map((link) => ({
      id: `go:${link.path}`,
      label: link.name,
      hint: link.path,
      group: 'Go to',
      icon: link.icon,
      run: () => window.location.assign(link.path),
    })),
    {
      id: 'action:new-trade',
      label: 'Log a new trade',
      hint: 'n',
      group: 'Actions',
      icon: 'plus',
      run: () => window.location.assign('/journal'),
    },
    {
      id: 'action:theme',
      label: `Switch to ${dark ? 'light' : 'dark'} theme`,
      group: 'Actions',
      icon: dark ? 'sun' : 'moon',
      run: () => toggleTheme(),
    },
    {
      id: 'action:shortcuts',
      label: 'Keyboard shortcuts',
      hint: '?',
      group: 'Actions',
      icon: 'keyboard',
      run: () => openShortcuts(),
    },
  ];
}

/**
 * Open the command palette dialog (no-op if already open; closes the shortcut sheet): a
 * filterable list of nav pages and actions, driven by arrow keys and Enter.
 */
export function openCommandPalette() {
  if (paletteOpen) return;
  shortcutsOpen?.close();
  const all = commands();
  let results = all;
  let active = 0;
  const listId = 'command-palette-list';
  const list = h('ul', {
    id: listId,
    role: 'listbox',
    'aria-label': t('Commands'),
    class: 'max-h-[min(20rem,50dvh)] overflow-y-auto overscroll-contain p-2',
  });
  const empty = h(
    'p',
    { role: 'status', class: 'px-4 py-8 text-center text-sm text-muted', hidden: true },
    'No matching command.',
  );
  const field = h('input', {
    placeholder: t('Jump to a page or run a command…'),
    role: 'combobox',
    'aria-label': t('Search commands'),
    'aria-expanded': 'true',
    'aria-autocomplete': 'list',
    'aria-controls': listId,
    class: 'h-12 w-full bg-transparent text-sm text-fg outline-none placeholder:text-subtle',
  });
  const run = (command) => {
    if (!command) return;
    paletteOpen?.close();
    command.run();
  };
  const paint = () => {
    list.replaceChildren();
    empty.hidden = results.length !== 0;
    let lastGroup = '';
    results.forEach((command, index) => {
      const showGroup = command.group !== lastGroup;
      lastGroup = command.group;
      const option = h(
        'button',
        {
          type: 'button',
          role: 'option',
          id: `${listId}-${index}`,
          'aria-selected': String(index === active),
          'aria-label': command.label,
          tabindex: '-1',
          class: cn(
            'flex w-full items-center gap-3 rounded-control px-2 py-2 text-left text-sm transition-colors',
            index === active ? 'bg-accent-soft text-accent' : 'text-fg',
          ),
          onmousedown: (event) => event.preventDefault(),
          onmouseenter: () => {
            active = index;
            paint();
          },
          onclick: () => run(command),
        },
        icon(command.icon, 16, 'shrink-0'),
        h('span', { class: 'flex-1 truncate' }, command.label),
        command.hint ? h('span', { class: 'tnum text-xs text-subtle' }, command.hint) : null,
      );
      list.append(
        h(
          'li',
          { role: 'presentation' },
          showGroup
            ? h(
                'p',
                {
                  class:
                    'px-2 pt-3 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase',
                },
                command.group,
              )
            : null,
          option,
        ),
      );
    });
    field.setAttribute('aria-activedescendant', results[active] ? `${listId}-${active}` : '');
    list.querySelectorAll('[role="option"]')[active]?.scrollIntoView?.({ block: 'nearest' });
  };
  field.addEventListener('input', () => {
    results = all.filter((command) => matches(field.value, command.label));
    active = 0;
    paint();
  });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.max(0, Math.min(active + 1, results.length - 1));
      paint();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      paint();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(results[active]);
    }
  });
  paint();
  paletteOpen = openDialog({
    label: 'Command palette',
    overlayClassName: 'z-[60] items-start pt-[12vh]',
    className: 'max-w-lg overflow-hidden rounded-card border border-line bg-surface shadow-2xl',
    initialFocus: field,
    onClose: () => {
      paletteOpen = null;
    },
    content: (close) =>
      h(
        'div',
        {},
        h(
          'div',
          { class: 'flex items-center gap-3 border-b border-line px-4' },
          icon('search', 16, 'shrink-0 text-muted'),
          field,
          h(
            'button',
            {
              type: 'button',
              onclick: close,
              'aria-label': t('Close command palette'),
              class:
                'focus-ring shrink-0 rounded-control p-2 text-muted hover:bg-elevated hover:text-fg',
            },
            icon('x', 16),
          ),
        ),
        empty,
        list,
        h(
          'div',
          {
            class: 'flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-subtle',
          },
          h('span', {}, '↑↓ to move'),
          h('span', {}, '↵ to select'),
          h('span', {}, 'esc to close'),
        ),
      ),
  });
}

function openShortcuts() {
  if (shortcutsOpen) return;
  shortcutsOpen = openDialog({
    label: 'Keyboard shortcuts',
    overlayClassName: 'z-[60]',
    className:
      'max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto overscroll-contain rounded-card border border-line bg-surface p-6 shadow-2xl',
    onClose: () => {
      shortcutsOpen = null;
    },
    content: (close) =>
      h(
        'div',
        {},
        h(
          'div',
          { class: 'mb-4 flex items-center justify-between gap-3' },
          h(
            'h2',
            { class: 'flex items-center gap-2 text-sm font-semibold text-fg' },
            icon('keyboard', 16),
            ' Keyboard shortcuts',
          ),
          h(
            'button',
            {
              type: 'button',
              onclick: close,
              'aria-label': t('Close keyboard shortcuts'),
              class:
                'focus-ring -mr-2 rounded-control p-2 text-muted hover:bg-elevated hover:text-fg',
            },
            icon('x', 16),
          ),
        ),
        h(
          'dl',
          { class: 'space-y-2' },
          SHORTCUTS.map((shortcut) =>
            h(
              'div',
              { class: 'flex items-center justify-between gap-4 text-sm' },
              h('dt', { class: 'text-muted' }, shortcut.description),
              h(
                'dd',
                { class: 'shrink-0' },
                h(
                  'kbd',
                  {
                    class:
                      'rounded border border-line bg-elevated px-2 py-0.5 tnum text-xs text-fg',
                  },
                  shortcut.keys,
                ),
              ),
            ),
          ),
        ),
        h(
          'p',
          { class: 'mt-5 text-xs text-subtle' },
          'Navigation shortcuts are ignored while you are typing in a field or using a dialog.',
        ),
      ),
  });
}

/**
 * Install the global keydown handler: ⌘K/Ctrl K toggles the palette, "g" + letter navigates
 * (within 1.5s), "n" goes to /journal, "?" opens the sheet. Ignored while typing or in other modals.
 */
export function bindShortcuts() {
  let pendingGoto = false;
  let gotoTimer;
  const clearGoto = () => {
    pendingGoto = false;
    clearTimeout(gotoTimer);
  };
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const foreignDialog =
      !paletteOpen &&
      !shortcutsOpen &&
      document.querySelector('[role="dialog"][aria-modal="true"]');
    if (foreignDialog) {
      clearGoto();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      clearGoto();
      if (paletteOpen) paletteOpen.close();
      else openCommandPalette();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
      clearGoto();
      return;
    }
    if (paletteOpen || shortcutsOpen) {
      if (event.key === '?' && shortcutsOpen) {
        event.preventDefault();
        shortcutsOpen.close();
      }
      return;
    }
    if (pendingGoto) {
      const destination = GOTO_KEYS[event.key.toLowerCase()];
      clearGoto();
      if (destination) {
        event.preventDefault();
        window.location.assign(destination);
      }
      return;
    }
    if (event.key === 'g') {
      pendingGoto = true;
      gotoTimer = setTimeout(clearGoto, 1500);
    } else if (event.key === '?') {
      event.preventDefault();
      openShortcuts();
    } else if (event.key === 'n') {
      event.preventDefault();
      window.location.assign('/journal');
    }
  });
  window.addEventListener('blur', clearGoto);
}
