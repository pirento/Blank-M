import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_FILTERS,
  describeFilters,
  isEmptyFilters,
  loadViews,
  saveViews,
  parseViews,
  upsertView,
} from '../../public/js/lib/views.js';
import { useCleanBrowserStorage } from '../helpers/browser-storage.js';

const filters = {
  search: 'RELIANCE',
  direction: 'Long',
  outcome: 'wins',
  from: '2026-01-01',
  to: '2026-03-31',
  segment: 'all',
  strategy: 'all',
};

function view(overrides = {}) {
  return { id: 'a', name: 'Q1 winners', filters, ...overrides };
}

describe('isEmptyFilters', () => {
  it('is true for the default filters', () => {
    expect(isEmptyFilters(EMPTY_FILTERS)).toBe(true);
  });

  it('treats whitespace-only search as empty', () => {
    expect(isEmptyFilters({ ...EMPTY_FILTERS, search: '   ' })).toBe(true);
  });

  it('is false as soon as anything narrows the list', () => {
    expect(isEmptyFilters({ ...EMPTY_FILTERS, direction: 'Short' })).toBe(false);
    expect(isEmptyFilters({ ...EMPTY_FILTERS, to: '2026-01-01' })).toBe(false);
  });
});

describe('describeFilters', () => {
  it('says so plainly when nothing is set', () => {
    expect(describeFilters(EMPTY_FILTERS)).toBe('No filters');
  });

  it('joins every active filter', () => {
    expect(describeFilters(filters)).toBe('“RELIANCE” · Long · wins · 2026-01-01 → 2026-03-31');
  });

  it('describes a one-sided date range', () => {
    expect(describeFilters({ ...EMPTY_FILTERS, from: '2026-02-01' })).toBe('from 2026-02-01');
    expect(describeFilters({ ...EMPTY_FILTERS, to: '2026-02-01' })).toBe('until 2026-02-01');
  });
});

describe('parseViews', () => {
  it('returns nothing for absent storage', () => {
    expect(parseViews(null)).toEqual([]);
  });

  it('returns nothing rather than throwing on invalid JSON', () => {
    expect(parseViews('{not json')).toEqual([]);
  });

  it('returns nothing when the payload is not an array', () => {
    expect(parseViews(JSON.stringify({ id: 'a' }))).toEqual([]);
  });

  it('round-trips a well-formed view', () => {
    expect(parseViews(JSON.stringify([view()]))).toEqual([view()]);
  });

  it('drops entries whose shape is wrong, keeping the good ones', () => {
    const raw = JSON.stringify([
      view(),
      { id: 'b', name: 'no filters' },
      { id: 'c', name: 'bad direction', filters: { ...filters, direction: 'sideways' } },
      { name: 'no id', filters },
      null,
      'a string',
    ]);
    expect(parseViews(raw)).toEqual([view()]);
  });

  it('caps how many views it will read back', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      view({ id: String(index), name: `View ${index}` }),
    );
    expect(parseViews(JSON.stringify(many))).toHaveLength(12);
  });
});

describe('upsertView', () => {
  it('appends a view with a new name', () => {
    const result = upsertView([view()], 'Losers', EMPTY_FILTERS);
    expect(result).toHaveLength(2);
    expect(result[1]?.name).toBe('Losers');
  });

  it('replaces the filters of a view with the same name instead of duplicating', () => {
    const result = upsertView([view()], 'Q1 winners', EMPTY_FILTERS);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('a');
    expect(result[0]?.filters).toEqual(EMPTY_FILTERS);
  });

  it('matches an existing name case-insensitively and ignores surrounding space', () => {
    const result = upsertView([view()], '  q1 WINNERS  ', EMPTY_FILTERS);
    expect(result).toHaveLength(1);
  });

  it('stops accepting new views once the cap is reached', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      view({ id: String(index), name: `View ${index}` }),
    );
    expect(upsertView(many, 'One more', EMPTY_FILTERS)).toHaveLength(12);
  });
});

const ownerKey = (ownerId) => `blank_transaction_views:v1:${encodeURIComponent(ownerId)}`;

useCleanBrowserStorage();

describe('owner-scoped saved views', () => {
  it('reloads each owner independently after A → B → A switching', () => {
    const aViews = [view({ name: 'A private view' })];
    const bViews = [view({ name: 'B private view', filters: { ...filters, search: 'B note' } })];
    expect(saveViews('account-a', aViews)).toBe(true);
    expect(loadViews('account-b')).toEqual([]);
    expect(saveViews('account-b', bViews)).toBe(true);
    expect(loadViews('account-a')).toEqual(aViews);
    expect(loadViews('account-b')).toEqual(bViews);
    expect(JSON.parse(localStorage.getItem(ownerKey('account-a')))).toEqual({
      version: 1,
      ownerId: 'account-a',
      views: aViews,
    });
  });

  it('does not read or write any storage without an owner', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    for (const owner of [null, '', '   ']) {
      expect(loadViews(owner)).toEqual([]);
      expect(saveViews(owner, [view()])).toBe(false);
    }
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps distinct owner identifiers in distinct keys', () => {
    saveViews('account/a', [view({ name: 'Slash owner' })]);
    saveViews('account%2Fa', [view({ name: 'Percent owner' })]);
    expect(loadViews('account/a')[0]?.name).toBe('Slash owner');
    expect(loadViews('account%2Fa')[0]?.name).toBe('Percent owner');
  });

  it('never claims, displays, rewrites, or deletes unowned legacy bytes', () => {
    const legacy = '  ' + JSON.stringify([view({ name: 'Unclaimed private name' })]) + '\n';
    localStorage.setItem('blank_transaction_views', legacy);
    localStorage.setItem('unrelated_preference', 'keep exactly');
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    expect(loadViews('account-a')).toEqual([]);
    expect(loadViews('account-b')).toEqual([]);
    expect(read).not.toHaveBeenCalledWith('blank_transaction_views');
    saveViews('account-a', [view({ name: 'New owned view' })]);
    expect(localStorage.getItem('blank_transaction_views')).toBe(legacy);
    expect(localStorage.getItem('unrelated_preference')).toBe('keep exactly');
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    '{broken json',
    'null',
    '[]',
    JSON.stringify([view()]),
    JSON.stringify({ version: 1, views: [view()] }),
    JSON.stringify({ version: 2, ownerId: 'account-a', views: [view()] }),
    JSON.stringify({ version: 1, ownerId: 'account-b', views: [view()] }),
    JSON.stringify({ version: 1, ownerId: 'account-a', views: {} }),
  ])(
    'ignores malformed, unowned, unsupported, or wrong-owner data without deleting it: %s',
    (raw) => {
      localStorage.setItem(ownerKey('account-a'), raw);
      expect(loadViews('account-a')).toEqual([]);
      expect(localStorage.getItem(ownerKey('account-a'))).toBe(raw);
    },
  );

  it('validates and caps entries inside a matching owner envelope', () => {
    localStorage.setItem(
      ownerKey('account-a'),
      JSON.stringify({
        version: 1,
        ownerId: 'account-a',
        views: [
          null,
          { name: 'Invalid' },
          ...Array.from({ length: 20 }, (_, index) => view({ id: String(index) })),
        ],
      }),
    );
    const views = loadViews('account-a');
    expect(views).toHaveLength(12);
    expect(views[0]?.id).toBe('0');
    expect(views[11]?.id).toBe('11');
    saveViews(
      'account-b',
      Array.from({ length: 20 }, (_, index) => view({ id: String(index) })),
    );
    expect(loadViews('account-b')).toHaveLength(12);
  });

  it('keeps the ledger usable when reading or writing storage is denied', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    expect(loadViews('account-a')).toEqual([]);
    expect(saveViews('account-a', [view()])).toBe(false);
  });

  it('handles a browser that denies access to localStorage itself', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    expect(loadViews('account-a')).toEqual([]);
    expect(saveViews('account-a', [view()])).toBe(false);
  });
});

describe('segment and strategy filters', () => {
  it('treat views saved before them as "all" and describe them', () => {
    const legacy = JSON.stringify([
      {
        id: 'v1',
        name: 'Old',
        filters: { search: '', direction: 'Long', outcome: 'all', from: '', to: '' },
      },
    ]);
    const [view] = parseViews(legacy);
    expect(view.filters).toMatchObject({ segment: 'all', strategy: 'all', direction: 'Long' });
    expect(isEmptyFilters({ ...EMPTY_FILTERS, segment: 'OPT' })).toBe(false);
    expect(describeFilters({ ...EMPTY_FILTERS, segment: 'OPT', strategy: 's1' }, () => 'ORB')).toBe(
      'OPT · ORB',
    );
    expect(describeFilters({ ...EMPTY_FILTERS, strategy: 'none' })).toBe('no strategy');
  });
});
