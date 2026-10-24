/**
 * Helpers available in every EJS view: formatting, class names, form styles,
 * icons and safe JSON for embedded page data.
 */
import { icon } from '../services/icons.js';
import { catalogFor, languageOf, translator } from '../services/i18n.js';
import { todayInIst } from '../shared/market.js';
import {
  ADMIN_NAV_GROUP,
  ADMIN_PANEL_NAV,
  NAV_LINKS,
  PRIMARY_NAV_LINKS,
  SECONDARY_NAV_GROUPS,
} from '../config/nav.js';

const currency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formats an amount as Indian rupees with two decimals, e.g. ₹1,23,456.00. */
export function formatCurrency(amount) {
  return currency.format(amount);
}

const JSON_ESCAPES = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/** JSON for a `<script type="application/json">` block; `<` can never close the tag. */
export function safeJson(value) {
  // One pass: page data can be megabytes.
  return JSON.stringify(value ?? null).replace(/[<>&\u2028\u2029]/g, (char) => JSON_ESCAPES[char]);
}

/** Joins truthy class names. */
export function cn(...parts) {
  return parts.flat().filter(Boolean).join(' ');
}

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  default: 'bg-accent text-accent-fg hover:bg-accent-hover',
  outline: 'border border-line-strong bg-surface text-fg hover:bg-elevated',
  ghost: 'text-muted hover:bg-elevated hover:text-fg',
  destructive: 'bg-negative text-white hover:opacity-90',
};
const BUTTON_SIZES = {
  sm: 'min-h-9 px-3 text-xs',
  default: 'min-h-10 px-4 text-sm',
  lg: 'min-h-12 px-6 text-sm',
  icon: 'h-10 w-10',
};
const BUTTON_BASE =
  'inline-flex items-center justify-center rounded-control font-normal whitespace-nowrap transition-[background-color,color,border-color,transform,box-shadow] active:translate-y-px disabled:pointer-events-none disabled:opacity-50';

/** Tailwind classes for a button of the given variant and size, plus any extra classes. */
export function buttonClass(variant = 'default', size = 'default', className = '') {
  return cn(BUTTON_BASE, 'focus-ring', BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
}

export const FIELD_CLASS =
  'w-full rounded-control border bg-surface px-3 text-sm text-fg transition-colors placeholder:text-subtle disabled:cursor-not-allowed disabled:opacity-60 h-10 border-line-strong focus-ring';
export const TEXTAREA_CLASS =
  'w-full rounded-control border bg-surface px-3 text-sm text-fg transition-colors placeholder:text-subtle disabled:cursor-not-allowed disabled:opacity-60 min-h-20 py-2 leading-relaxed border-line-strong focus-ring';
export const LABEL_CLASS = 'mb-1.5 block text-xs font-medium text-muted';

/** Two-letter initials from the member's email, e.g. ravi.kumar@… → RK. */
export function initialsFor(email) {
  const local = String(email || '').split('@')[0];
  const parts = local.split(/[._\-+\d]+/).filter(Boolean);
  const letters =
    parts.length >= 2
      ? parts[0][0] + parts[1][0]
      : (parts[0] || local).replace(/[^a-z]/gi, '').slice(0, 2);
  return letters.toUpperCase() || 'ME';
}

/** Template locals shared by every view. */
export function viewHelpers(req, res, next) {
  const isAdmin = req.auth?.user?.role === 'admin' && !req.auth?.accessError;
  const lang = languageOf(req);
  const t = translator(lang);
  // Navigation in the interface language (paths and icons unchanged).
  const translate = (links) => links.map((link) => ({ ...link, name: t(link.name) }));
  const translateGroups = (groups) =>
    groups.map((group) => ({ ...group, group: t(group.group), items: translate(group.items) }));
  Object.assign(res.locals, {
    lang,
    t,
    i18nCatalog: catalogFor(lang),
    icon,
    cn,
    safeJson,
    formatCurrency,
    buttonClass,
    FIELD_CLASS,
    TEXTAREA_CLASS,
    LABEL_CLASS,
    currentPath: req.path,
    memberEmail: req.auth?.user?.email ?? '',
    memberInitials: initialsFor(req.auth?.user?.email),
    today: todayInIst(),
    isAdmin,
    primaryLinks: translate(
      isAdmin ? [...PRIMARY_NAV_LINKS, ...ADMIN_NAV_GROUP.items] : PRIMARY_NAV_LINKS,
    ),
    secondaryGroups: translateGroups(
      isAdmin ? [...SECONDARY_NAV_GROUPS, ADMIN_NAV_GROUP] : SECONDARY_NAV_GROUPS,
    ),
    allNavLinks: translate([...NAV_LINKS, ...ADMIN_NAV_GROUP.items]),
    navLinks: translate(NAV_LINKS),
  });
  /** Render an admin panel view inside the admin layout (views/layouts/admin.ejs). */
  res.renderAdmin = (view, locals = {}) => {
    const page = { ...res.locals, adminNav: ADMIN_PANEL_NAV, ...locals };
    req.app.render(view, page, (error, body) => {
      if (error) return next(error);
      res.render('layouts/admin', { adminNav: ADMIN_PANEL_NAV, ...locals, body });
    });
  };
  /** Render a page view inside the workspace shell layout. */
  res.renderWorkspace = (view, locals = {}) => {
    const page = { ...res.locals, ...locals };
    req.app.render(view, page, (error, body) => {
      if (error) return next(error);
      res.render('layouts/workspace', { ...locals, body });
    });
  };
  next();
}
