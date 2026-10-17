/**
 * Lucide icons for EJS templates and the sprite used by browser modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ICON_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../node_modules/lucide-static/icons',
);
const cache = new Map();

function body(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid icon name: ${name}`);
  if (!cache.has(name)) {
    const source = fs.readFileSync(path.join(ICON_DIRECTORY, `${name}.svg`), 'utf8');
    const inner = source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^[\s\S]*?<svg[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '')
      .trim();
    cache.set(name, inner);
  }
  return cache.get(name);
}

const escapeAttribute = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Inline Lucide icon markup for EJS templates (decorative unless labelled). */
export function icon(name, { size = 16, className = '', label } = {}) {
  const accessibility = label
    ? `role="img" aria-label="${escapeAttribute(label)}"`
    : 'aria-hidden="true" focusable="false"';
  return `<svg class="lucide lucide-${name} ${escapeAttribute(className)}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${accessibility}>${body(name)}</svg>`;
}

/** Icons the browser modules reference through `/icons.svg#name`. */
export const CLIENT_ICONS = [
  'activity',
  'alert-circle',
  'arrow-down-right',
  'arrow-left',
  'arrow-right',
  'arrow-right-left',
  'arrow-up-right',
  'ban',
  'bar-chart-2',
  'bar-chart-3',
  'beaker',
  'bell',
  'book-open',
  'bookmark-plus',
  'bot',
  'brain-circuit',
  'briefcase',
  'calculator',
  'calendar',
  'calendar-days',
  'check',
  'check-check',
  'check-circle-2',
  'chevron-down',
  'chevron-left',
  'chevron-right',
  'chevron-up',
  'circle-help',
  'circle-stop',
  'clock',
  'copy',
  'corner-down-left',
  'download',
  'file-scan',
  'file-up',
  'external-link',
  'eye',
  'eye-off',
  'file-bar-chart',
  'file-down',
  'file-text',
  'filter',
  'flag',
  'globe',
  'grid-3x3',
  'history',
  'image',
  'info',
  'key-round',
  'keyboard',
  'layout-dashboard',
  'lightbulb',
  'link',
  'link-2',
  'list',
  'list-checks',
  'loader-2',
  'lock',
  'log-out',
  'mail',
  'mic',
  'minus',
  'moon',
  'newspaper',
  'notebook-pen',
  'paperclip',
  'pencil',
  'pie-chart',
  'plus',
  'printer',
  'qr-code',
  'receipt',
  'refresh-cw',
  'rotate-ccw',
  'save',
  'scale',
  'search',
  'send',
  'send-horizontal',
  'settings',
  'settings-2',
  'shield',
  'shield-check',
  'sliders-horizontal',
  'smartphone',
  'sparkles',
  'square',
  'star',
  'sun',
  'target',
  'trash-2',
  'trending-down',
  'trending-up',
  'triangle-alert',
  'undo-2',
  'unlink',
  'unlock',
  'upload',
  'upload-cloud',
  'user-round',
  'user-round-x',
  'users-round',
  'wallet',
  'wand-2',
  'x',
  'zap',
];

let sprite = null;
/**
 * An SVG sprite with one `<symbol>` per client icon (ids are the icon names), built once and
 * cached.
 */
export function iconSprite() {
  sprite ??= `<svg xmlns="http://www.w3.org/2000/svg"><defs>${CLIENT_ICONS.map(
    (name) => `<symbol id="${name}" viewBox="0 0 24 24">${body(name)}</symbol>`,
  ).join('')}</defs></svg>`;
  return sprite;
}
