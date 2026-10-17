/**
 * Schema building blocks shared by the models: UUID string IDs, timestamps and ISO dates.
 */
import { randomUUID } from 'node:crypto';

/** All owner records use UUID string identifiers, matching the original contracts. */
export const uuidId = { type: String, default: () => randomUUID() };

export const timestamps = { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } };

/** ISO strings for dates, so API payloads keep the `datetime` shape clients validate. */
export function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
