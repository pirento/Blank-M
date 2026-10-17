/**
 * Saved filter views for the transactions ledger.
 *
 * Names and search text can be private, so every persisted view belongs to an
 * explicit account. This prevents accidental cross-account UI carryover; plain
 * localStorage is not a secure vault against people with browser/device access.
 * The unowned legacy key is intentionally never read, claimed, or removed.
 * See docs/SAVED-VIEWS.md for preservation and recovery behavior.
 */

export const EMPTY_FILTERS = {
  search: '',
  direction: 'all',
  outcome: 'all',
  from: '',
  to: '',
  // 'all', 'EQ', 'FUT' or 'OPT'.
  segment: 'all',
  // 'all', 'none' (no strategy) or a strategy ID.
  strategy: 'all',
};

const STORAGE_PREFIX = 'blank_transaction_views:v1:';
const MAX_VIEWS = 12;

/** True when nothing is narrowed, so the UI can hide a pointless "clear". */
export function isEmptyFilters(filters) {
  return (
    filters.search.trim() === '' &&
    filters.direction === 'all' &&
    filters.outcome === 'all' &&
    filters.from === '' &&
    filters.to === '' &&
    (filters.segment ?? 'all') === 'all' &&
    (filters.strategy ?? 'all') === 'all'
  );
}

/** Describes a view in one line, so a saved name is not the only clue. */
export function describeFilters(filters, strategyName = () => null) {
  const parts = [];
  if ((filters.segment ?? 'all') !== 'all') parts.push(filters.segment);
  if ((filters.strategy ?? 'all') === 'none') parts.push('no strategy');
  else if ((filters.strategy ?? 'all') !== 'all')
    parts.push(strategyName(filters.strategy) ?? 'a strategy');
  if (filters.search.trim()) parts.push(`“${filters.search.trim()}”`);
  if (filters.direction !== 'all') parts.push(filters.direction);
  if (filters.outcome !== 'all') parts.push(filters.outcome);
  if (filters.from && filters.to) parts.push(`${filters.from} → ${filters.to}`);
  else if (filters.from) parts.push(`from ${filters.from}`);
  else if (filters.to) parts.push(`until ${filters.to}`);
  return parts.length > 0 ? parts.join(' · ') : 'No filters';
}

function isFilters(value) {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value;
  return (
    typeof candidate.search === 'string' &&
    (candidate.direction === 'all' ||
      candidate.direction === 'Long' ||
      candidate.direction === 'Short') &&
    (candidate.outcome === 'all' ||
      candidate.outcome === 'wins' ||
      candidate.outcome === 'losses') &&
    typeof candidate.from === 'string' &&
    typeof candidate.to === 'string' &&
    // Added later: absent in views saved before them.
    (candidate.segment === undefined || ['all', 'EQ', 'FUT', 'OPT'].includes(candidate.segment)) &&
    (candidate.strategy === undefined || typeof candidate.strategy === 'string')
  );
}

/**
 * Anything malformed is dropped rather than trusted: this is parsing
 * user-editable storage, and a bad entry must not take the page down.
 */
export function parseViews(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return validViews(parsed);
  } catch {
    return [];
  }
}

function validViews(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.id === 'string' &&
        typeof entry.name === 'string' &&
        isFilters(entry.filters),
    )
    .map((entry) => ({ ...entry, filters: { ...EMPTY_FILTERS, ...entry.filters } }))
    .slice(0, MAX_VIEWS);
}

function ownerKey(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) return null;
  return `${STORAGE_PREFIX}${encodeURIComponent(ownerId)}`;
}

/** Read only this owner's versioned envelope, never the unowned legacy array. */
export function loadViews(ownerId) {
  try {
    const key = ownerKey(ownerId);
    if (!key) return [];
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const payload = JSON.parse(raw);
    if (typeof payload !== 'object' || payload === null) return [];
    const envelope = payload;
    if (envelope.version !== 1 || envelope.ownerId !== ownerId) return [];
    return validViews(envelope.views);
  } catch {
    // Denied/unavailable storage and malformed data must not break the ledger.
    return [];
  }
}

/** A failed write stays usable in memory; callers must not claim it persisted. */
export function saveViews(ownerId, views) {
  try {
    const key = ownerKey(ownerId);
    if (!key) return false;
    window.localStorage.setItem(
      key,
      JSON.stringify({ version: 1, ownerId, views: views.slice(0, MAX_VIEWS) }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Replaces a view of the same name rather than accumulating duplicates. */
export function upsertView(views, name, filters) {
  const trimmed = name.trim();
  const existing = views.find((view) => view.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    return views.map((view) => (view.id === existing.id ? { ...view, filters } : view));
  }
  return [...views, { id: crypto.randomUUID(), name: trimmed, filters }].slice(0, MAX_VIEWS);
}
