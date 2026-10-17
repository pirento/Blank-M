/**
 * Browser checkpoint for a trade import, so an interrupted import can be
 * resumed or retried without creating duplicate trades.
 */
import { z } from 'zod';

import { computeTradeEconomics } from '../../../shared/pnl.js';

import { isBusinessDate } from '../../../shared/business-dates.js';

const operationSchema = z.object({
  line: z.number().int().positive(),
  status: z.enum(['pending', 'unknown', 'failed', 'acknowledged']),
  trade: z.object({
    id: z.string().uuid(),
    date: z.string().refine(isBusinessDate),
    symbol: z.string().min(1),
    type: z.enum(['Long', 'Short']),
    entryPrice: z.number().finite().positive(),
    exitPrice: z.number().finite().positive(),
    quantity: z.number().int().positive(),
    grossPnl: z.number().finite(),
    charges: z.number().finite().nonnegative(),
    pnl: z.number().finite(),
    notes: z.string(),
    strategyId: z.null(),
    createdAt: z.string().datetime(),
  }),
});
const batchSchema = z.object({
  version: z.literal(1),
  ownerId: z.string().min(1),
  fileName: z.string(),
  reference: z.string(),
  operations: z.array(operationSchema).min(1),
});

const key = (ownerId) => `blank.import.v1.${ownerId}`;

/** Recovery is scoped to the signed-in account in this browser tab, including reloads.
 * Without this checkpoint, reselecting identical CSV content/mapping/reference recovers
 * row IDs across devices. Reconstructed payload differences fail closed at the database.
 */
export function readImportBatch(ownerId) {
  const raw = sessionStorage.getItem(key(ownerId));
  if (!raw) return null;
  const batch = batchSchema.parse(JSON.parse(raw));
  if (batch.ownerId !== ownerId)
    throw new Error('The saved import belongs to a different account.');
  return batch;
}

/** Save the import checkpoint to sessionStorage under the batch owner's key. */
export function saveImportBatch(batch) {
  // Do not write remotely unless its stable IDs and frozen payload are recoverable locally.
  sessionStorage.setItem(key(batch.ownerId), JSON.stringify(batch));
}

/** Remove the owner's import checkpoint from sessionStorage. */
export function clearImportBatch(ownerId) {
  sessionStorage.removeItem(key(ownerId));
}

/** Promise of the SHA-256 of a string as lowercase hex. */
export async function hashImportSource(content) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Deterministic UUID derived from account, exact decoded CSV, explicit mapping and row.
 * Reference is blank for the normal operation; a user-supplied distinct reference permits
 * an intentional additional copy, and must be reused when retrying that separate import.
 */
export async function createImportBatch(
  ownerId,
  fileName,
  candidates,
  charges,
  sourceDigest,
  mapping,
  reference = '',
) {
  const mappedColumns = [
    mapping.date,
    mapping.symbol,
    mapping.type,
    mapping.entryPrice,
    mapping.exitPrice,
    mapping.quantity,
    mapping.notes,
    mapping.priceBasis ?? 'entry-exit',
  ];
  const operation = JSON.stringify([
    'blank-import-v1',
    ownerId,
    sourceDigest,
    mappedColumns,
    reference,
  ]);
  return {
    version: 1,
    ownerId,
    fileName,
    reference,
    operations: await Promise.all(
      candidates.map(async ({ line, ...input }) => {
        const digest = await hashImportSource(`${operation}:${line}`);
        // UUIDv8: application-defined SHA-256 identity, with RFC variant bits.
        const hex =
          digest.slice(0, 12) +
          '8' +
          digest.slice(13, 16) +
          ((parseInt(digest[16], 16) & 3) | 8).toString(16) +
          digest.slice(17, 32);
        const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        const economics = computeTradeEconomics(input, charges);
        return {
          line,
          status: 'pending',
          trade: {
            ...input,
            id,
            createdAt: new Date().toISOString(),
            strategyId: null,
            grossPnl: economics.grossPnl,
            charges: economics.charges,
            pnl: economics.netPnl,
          },
        };
      }),
    ),
  };
}

/** Number of rows in a batch: total and per status (acknowledged, failed, unknown, pending). */
export function importCounts(batch) {
  return {
    total: batch.operations.length,
    acknowledged: batch.operations.filter((row) => row.status === 'acknowledged').length,
    failed: batch.operations.filter((row) => row.status === 'failed').length,
    unknown: batch.operations.filter((row) => row.status === 'unknown').length,
    pending: batch.operations.filter((row) => row.status === 'pending').length,
  };
}
