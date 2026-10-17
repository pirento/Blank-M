import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCandidates, guessMapping, parseCsv } from '../../shared/csv.js';
import {
  createImportBatch,
  hashImportSource,
  readImportBatch,
  saveImportBatch,
  clearImportBatch,
} from '../../public/js/lib/import-ledger.js';
import { DEFAULT_CHARGES } from '../../shared/types.js';
const csv =
  'Date,Symbol,Side,Qty,Entry,Exit\n2026-10-05,TCS,BUY,10,100,110\n2026-10-05,TCS,BUY,10,100,110';
const parsed = parseCsv(csv);
const mapping = guessMapping(parsed.headers);
const { candidates } = buildCandidates(parsed.rows, mapping);
const create = async (owner = 'owner-a', reference = '', content = csv) =>
  createImportBatch(
    owner,
    'trades.csv',
    candidates,
    DEFAULT_CHARGES,
    await hashImportSource(content),
    mapping,
    reference,
  );
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear();
});
describe('recoverable import identities and frozen checkpoint', () => {
  it('reconstructs stable per-row IDs across reload, tabs and devices, preserving identical rows', async () => {
    const original = await create();
    const later = await create();
    expect(later.operations.map((row) => row.trade.id)).toEqual(
      original.operations.map((row) => row.trade.id),
    );
    expect(new Set(original.operations.map((row) => row.trade.id)).size).toBe(2);
    saveImportBatch(original);
    expect(readImportBatch('owner-a')).toEqual(original);
    clearImportBatch('owner-a');
    expect(readImportBatch('owner-a')).toBeNull();
    expect((await create()).operations[0]?.trade.id).toBe(original.operations[0]?.trade.id);
  });
  it('separates accounts, explicit additional-copy references, mapping and content', async () => {
    const original = await create();
    const id = original.operations[0]?.trade.id;
    expect((await create('owner-b')).operations[0]?.trade.id).not.toBe(id);
    expect((await create('owner-a', 'intentional second copy')).operations[0]?.trade.id).not.toBe(
      id,
    );
    expect((await create('owner-a', '', csv + '\n')).operations[0]?.trade.id).not.toBe(id);
    const remapped = await createImportBatch(
      'owner-a',
      'trades.csv',
      candidates,
      DEFAULT_CHARGES,
      await hashImportSource(csv),
      { ...mapping, priceBasis: 'buy-sell' },
    );
    expect(remapped.operations[0]?.trade.id).not.toBe(id);
  });
  it('recovers unknown/acknowledged statuses and historical charge payload independently of current settings', async () => {
    const batch = await create();
    batch.operations[0].status = 'acknowledged';
    batch.operations[1].status = 'unknown';
    saveImportBatch(batch);
    const resumed = readImportBatch('owner-a');
    expect(resumed).toEqual(batch);
    const repriced = await createImportBatch(
      'owner-a',
      'trades.csv',
      candidates,
      { ...DEFAULT_CHARGES, enabled: false },
      await hashImportSource(csv),
      mapping,
    );
    expect(repriced.operations[0]?.trade.id).toBe(batch.operations[0]?.trade.id);
    expect(repriced.operations[0]?.trade.charges).not.toBe(batch.operations[0]?.trade.charges);
  });
  it('never adopts another account checkpoint, even if copied into the matching storage key', async () => {
    saveImportBatch(await create());
    expect(readImportBatch('owner-b')).toBeNull();
    sessionStorage.setItem(
      'blank.import.v1.owner-b',
      sessionStorage.getItem('blank.import.v1.owner-a'),
    );
    expect(() => readImportBatch('owner-b')).toThrow(/different account/);
  });
  it('rejects malformed saved checkpoints rather than silently resuming a new operation', () => {
    sessionStorage.setItem('blank.import.v1.owner-a', '{broken');
    expect(() => readImportBatch('owner-a')).toThrow();
  });
});
