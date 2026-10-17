/**
 * Order plans (frozen planning estimates): browser storage, review status and
 * validation of the records synced to the cloud.
 */
import { z } from 'zod';
import { NSE_SYMBOL_RE } from './ai-schemas.js';
import { calculateRiskPlan, deriveRiskPrices } from './risk-calculator.js';

/** A frozen planning estimate, never a submitted order or a realised trade. */

const PREFIX = 'blank_manual_plans:v1:';
const CHANGED = 'blank:manual-plans-changed';
const CORRUPT =
  'Saved plans in this browser contain invalid or unsupported data. Existing data has been preserved; restore it before making changes.';
const UNAVAILABLE =
  'Could not access saved plans in this browser. Check browser storage permissions and available space.';

const text = z.string().max(20000);
const identifier = z.string().min(1).max(300);
const numericInput = z.string().max(400);
const direction = z.enum(['Long', 'Short']);
const product = z.enum(['MIS', 'CNC']);
const symbol = z.string().regex(NSE_SYMBOL_RE);
const date = z.string().datetime({ offset: true });
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const charges = z
  .object({
    enabled: z.boolean(),
    brokeragePercent: z.number().finite().nonnegative(),
    brokerageMaxPerOrder: z.number().finite().nonnegative(),
    sttPercent: z.number().finite().nonnegative(),
    exchangeTxnPercent: z.number().finite().nonnegative(),
    sebiPercent: z.number().finite().nonnegative(),
    gstPercent: z.number().finite().nonnegative(),
    stampDutyPercent: z.number().finite().nonnegative(),
  })
  .strict();
const inputs = z
  .object({
    direction,
    accountSize: numericInput,
    availableCapital: numericInput.optional(),
    riskPercent: numericInput,
    entryPrice: numericInput,
    stopLoss: numericInput,
    takeProfit: numericInput.optional(),
    quantity: numericInput.optional(),
    product: product.optional(),
    marginPercent: numericInput.optional(),
    estimatedRoundTripCharges: numericInput.optional(),
    stopDistancePercent: numericInput.optional(),
    rewardMultiple: numericInput.optional(),
    priceMode: z.enum(['prices', 'percent']).optional(),
  })
  .strict();
const estimate = z
  .object({
    quantity: money,
    suggestedQuantity: money,
    isManualQuantity: z.boolean(),
    riskBudgetPaise: money,
    availableCapitalPaise: money,
    positionValuePaise: money,
    requiredMarginPaise: money,
    stopGrossLossPaise: money,
    stopFeesPaise: money,
    stopLossIncludingFeesPaise: money,
    capitalRequiredPaise: money,
    targetGrossProfitPaise: money.nullable(),
    targetFeesPaise: money.nullable(),
    targetNetProfitPaise: z
      .number()
      .int()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    netRewardRiskRatio: z.number().finite().nullable(),
    exceedsRiskBudget: z.boolean(),
    exceedsCapital: z.boolean(),
  })
  .strict();

const draftSchema = z
  .object({
    symbol,
    direction,
    product,
    inputs,
    estimate,
    chargesSnapshot: charges,
    strategySnapshot: z
      .object({ id: identifier, name: text, rules: text.optional() })
      .strict()
      .nullable(),
    rulesSnapshot: z
      .array(z.object({ id: identifier, section: text, rule: text }).strict())
      .max(1000),
    quoteSnapshot: z
      .object({
        symbol,
        price: z.number().finite().positive(),
        currency: z.string().min(1).max(20).nullable(),
        source: z.string().min(1).max(300),
        asOf: date.nullable(),
        fetchedAt: date,
      })
      .strict()
      .nullable(),
  })
  .strict();

const planSchema = draftSchema
  .extend({
    id: z.string().uuid(),
    ownerId: identifier,
    version: z.literal(1),
    recordKind: z.literal('manual-plan'),
    createdAt: date,
    reviewedAt: date.nullable(),
  })
  .strict();

const reviewSchema = z
  .object({
    id: z.string().uuid(),
    ownerId: identifier,
    version: z.literal(1),
    recordKind: z.literal('manual-plan-review'),
    reviewedAt: date.nullable(),
    eventId: z.string().uuid().optional(),
  })
  .strict();

const removalSchema = z
  .object({
    id: z.string().uuid(),
    ownerId: identifier,
    version: z.literal(1),
    recordKind: z.literal('manual-plan-removal'),
    removedAt: date,
  })
  .strict();

function prefix(ownerId) {
  if (!identifier.safeParse(ownerId).success || !ownerId.trim()) {
    throw new Error('Sign in before saving or changing plans.');
  }
  return `${PREFIX}${encodeURIComponent(ownerId)}:`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    throw new Error(UNAVAILABLE);
  }
}

function read(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    throw new Error(UNAVAILABLE);
  }
}

function write(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error(UNAVAILABLE);
  }
}

function parse(schema, raw) {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new Error(CORRUPT);
  }
}

/** The saved estimate must be precisely reproducible from its own frozen inputs. */
function validEconomics(draft) {
  if (
    draft.direction !== draft.inputs.direction ||
    draft.product !== (draft.inputs.product ?? 'MIS') ||
    (draft.product === 'CNC' && draft.direction === 'Short') ||
    (draft.quoteSnapshot !== null &&
      (draft.quoteSnapshot.symbol !== draft.symbol || draft.quoteSnapshot.currency !== 'INR'))
  ) {
    return false;
  }
  // Reports display these frozen prices directly. Percentage mode must retain
  // the same exact derived strings that produced the saved economic estimate.
  if (draft.inputs.priceMode === 'percent') {
    const prices = deriveRiskPrices(draft.inputs);
    if (
      !prices.valid ||
      prices.stopLoss !== draft.inputs.stopLoss ||
      prices.takeProfit !== draft.inputs.takeProfit
    ) {
      return false;
    }
  }
  const result = calculateRiskPlan(draft.inputs, draft.chargesSnapshot);
  return (
    result.valid &&
    result.plan.quantity > 0 &&
    !result.plan.exceedsRiskBudget &&
    !result.plan.exceedsCapital &&
    Object.keys(result.plan).every((key) => result.plan[key] === draft.estimate[key])
  );
}

function keysForOwner(storage, ownerPrefix) {
  try {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(ownerPrefix)) keys.push(key);
    }
    return keys;
  } catch {
    throw new Error(UNAVAILABLE);
  }
}

/**
 * Independent immutable plan records prevent concurrent additions losing data.
 * Review changes never rewrite economics. Permanent removal markers win over a
 * stale review or plan write from another tab, so removed plans cannot resurface.
 * This is browser-local storage, not cloud persistence or an execution ledger.
 */
export function loadOrderPlans(ownerId) {
  if (ownerId === null || !ownerId.trim()) return [];
  const ownerPrefix = prefix(ownerId);
  const storage = browserStorage();
  const plans = [];
  function isRemoved(id) {
    const raw = read(storage, `${ownerPrefix}removed:${id}`);
    if (raw === null) return false;
    const marker = parse(removalSchema, raw);
    if (marker.ownerId !== ownerId || marker.id !== id) throw new Error(CORRUPT);
    return true;
  }
  for (const key of keysForOwner(storage, ownerPrefix)) {
    const suffix = key.slice(ownerPrefix.length);
    // A committed deletion is authoritative even if a stale tab restores a
    // damaged payload or review. Validate the owner-bound tombstone first.
    const record = /^(?:plan|review):(.+)$/.exec(suffix);
    if (record && z.string().uuid().safeParse(record[1]).success && isRemoved(record[1])) {
      continue;
    }
    const raw = read(storage, key);
    if (raw === null) continue;
    if (suffix.startsWith('plan:')) {
      const plan = parse(planSchema, raw);
      if (
        plan.ownerId !== ownerId ||
        suffix !== `plan:${plan.id}` ||
        plan.reviewedAt !== null ||
        !validEconomics(plan)
      ) {
        throw new Error(CORRUPT);
      }
      plans.push(plan);
    } else if (suffix.startsWith('review:')) {
      const review = parse(reviewSchema, raw);
      if (review.ownerId !== ownerId || suffix !== `review:${review.id}`) throw new Error(CORRUPT);
    } else if (suffix.startsWith('removed:')) {
      const removal = parse(removalSchema, raw);
      if (removal.ownerId !== ownerId || suffix !== `removed:${removal.id}`)
        throw new Error(CORRUPT);
    } else {
      throw new Error(CORRUPT);
    }
  }
  return plans
    .flatMap((plan) => {
      // Read markers again even if they were added after enumeration began.
      if (isRemoved(plan.id)) return [];
      const review = read(storage, `${ownerPrefix}review:${plan.id}`);
      if (review !== null) {
        const marker = parse(reviewSchema, review);
        if (marker.ownerId !== ownerId || marker.id !== plan.id) throw new Error(CORRUPT);
        plan.reviewedAt = marker.reviewedAt;
      }
      return [plan];
    })
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id),
    );
}

function notify(ownerId) {
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: ownerId }));
}

/**
 * Validates a draft and saves it to this browser's localStorage under the owner with a new id,
 * then notifies subscribers. Throws on an invalid draft or corrupt existing plans; returns a copy.
 */
export function saveOrderPlan(ownerId, input) {
  const ownerPrefix = prefix(ownerId);
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success || !validEconomics(parsed.data)) {
    throw new Error(
      'Only a valid plan within your risk and capital limits can be saved. Check the instrument, product, inputs and estimate.',
    );
  }
  // A malformed existing record must never be silently replaced or hidden.
  loadOrderPlans(ownerId);
  const storage = browserStorage();
  const plan = {
    ...clone(parsed.data),
    id: crypto.randomUUID(),
    ownerId,
    version: 1,
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    recordKind: 'manual-plan',
  };
  if (
    ['plan', 'review', 'removed'].some(
      (kind) => read(storage, `${ownerPrefix}${kind}:${plan.id}`) !== null,
    )
  ) {
    throw new Error('Could not create a unique plan. Try saving again.');
  }
  write(storage, `${ownerPrefix}plan:${plan.id}`, plan);
  notify(ownerId);
  return clone(plan);
}

/**
 * Deletes a plan by writing an owner-bound removal tombstone, then best-effort removes its plan
 * and review records. Throws if the plan is not among this owner's saved plans.
 */
export function removeOrderPlan(ownerId, id) {
  const ownerPrefix = prefix(ownerId);
  const plan = loadOrderPlans(ownerId).find((candidate) => candidate.id === id);
  if (!plan) throw new Error('This plan is no longer available in this account.');
  const storage = browserStorage();
  write(storage, `${ownerPrefix}removed:${id}`, {
    id,
    ownerId,
    version: 1,
    recordKind: 'manual-plan-removal',
    removedAt: new Date().toISOString(),
  });
  // The committed tombstone is authoritative even if optional cleanup is denied.
  try {
    storage.removeItem(`${ownerPrefix}plan:${id}`);
    storage.removeItem(`${ownerPrefix}review:${id}`);
  } catch {
    // Keep the marker; a stale tab must never resurrect this plan.
  }
  notify(ownerId);
}

/** Marks a plan reviewed (now) or unreviewed via its review record; a no-op if already in that state. */
export function setOrderPlanReviewed(ownerId, id, reviewed) {
  const ownerPrefix = prefix(ownerId);
  if (typeof reviewed !== 'boolean') throw new Error('Choose a valid review state.');
  const plan = loadOrderPlans(ownerId).find((candidate) => candidate.id === id);
  if (!plan) throw new Error('This plan is no longer available in this account.');
  if (Boolean(plan.reviewedAt) === reviewed) return;
  write(browserStorage(), `${ownerPrefix}review:${id}`, {
    id,
    ownerId,
    version: 1,
    recordKind: 'manual-plan-review',
    reviewedAt: reviewed ? new Date().toISOString() : null,
    eventId: crypto.randomUUID(),
  });
  notify(ownerId);
}

/**
 * Calls `listener` when this owner's plans change in this tab or, via `storage` events, in
 * another tab. Returns an unsubscribe function.
 */
export function subscribeOrderPlans(ownerId, listener) {
  const ownerPrefix = prefix(ownerId);
  const local = (event) => {
    if (event.detail === ownerId) listener();
  };
  const external = (event) => {
    if (event.key === null || event.key.startsWith(ownerPrefix)) listener();
  };
  window.addEventListener(CHANGED, local);
  window.addEventListener('storage', external);
  return () => {
    window.removeEventListener(CHANGED, local);
    window.removeEventListener('storage', external);
  };
}

const MAX_CLOUD_RECORD_BYTES = 262144;

/** Compare JSON values independently of object key order (stored documents may reorder keys). */
export function samePlanRecord(left, right) {
  if (
    left.user_id !== right.user_id ||
    left.record_key !== right.record_key ||
    left.record_kind !== right.record_kind
  )
    return false;
  // A removal made independently on two devices has the same permanent meaning.
  if (left.record_kind === 'removed') return true;
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  };
  return canonical(left.record) === canonical(right.record);
}

/** Validate remote records before they can modify any browser-owned data. */
export function validateOrderPlanRecord(ownerId, candidate) {
  if (!candidate || candidate.user_id !== ownerId) throw new Error(CORRUPT);
  const raw = JSON.stringify(candidate.record);
  if (!raw || new TextEncoder().encode(raw).length > MAX_CLOUD_RECORD_BYTES) {
    throw new Error(
      'A saved plan is too large to sync safely. Existing browser data has been preserved.',
    );
  }
  if (candidate.record_kind === 'plan') {
    const plan = parse(planSchema, raw);
    if (
      plan.ownerId !== ownerId ||
      plan.reviewedAt !== null ||
      candidate.record_key !== `plan:${plan.id}` ||
      !validEconomics(plan)
    )
      throw new Error(CORRUPT);
  } else if (candidate.record_kind === 'removed') {
    const removal = parse(removalSchema, raw);
    if (removal.ownerId !== ownerId || candidate.record_key !== `removed:${removal.id}`)
      throw new Error(CORRUPT);
  } else if (candidate.record_kind === 'review') {
    const review = parse(reviewSchema, raw);
    if (
      review.ownerId !== ownerId ||
      !review.eventId ||
      candidate.record_key !== `review:${review.id}:${review.eventId}`
    )
      throw new Error(CORRUPT);
  } else throw new Error(CORRUPT);
  return clone(candidate);
}

/** Local records themselves form a durable retry queue, including removals. */
export function exportOrderPlanRecords(ownerId) {
  loadOrderPlans(ownerId);
  const storage = browserStorage();
  const ownerPrefix = prefix(ownerId);
  const records = [];
  for (const key of keysForOwner(storage, ownerPrefix)) {
    const suffix = key.slice(ownerPrefix.length);
    const raw = read(storage, key);
    if (raw === null) continue;
    const [kind, id] = suffix.split(':');
    if (
      (kind === 'plan' || kind === 'review') &&
      read(storage, `${ownerPrefix}removed:${id}`) !== null
    )
      continue;
    let record = JSON.parse(raw);
    let recordKey = suffix;
    if (kind === 'review') {
      const review = parse(reviewSchema, raw);
      if (!review.eventId) {
        review.eventId = crypto.randomUUID();
        // A stable event UUID makes an uncertain upload safe to retry.
        write(storage, key, review);
      }
      record = review;
      recordKey = `review:${review.id}:${review.eventId}`;
    }
    records.push(
      validateOrderPlanRecord(ownerId, {
        user_id: ownerId,
        record_key: recordKey,
        record_kind: kind,
        record,
      }),
    );
  }
  return records;
}

/**
 * Append immutable remote data, then reconcile acknowledged review events.
 * A pending local review survives a concurrent download. Tombstones always win.
 * No journal or execution data is read or written by this operation.
 */
export function mergeOrderPlanRecords(ownerId, incoming) {
  loadOrderPlans(ownerId);
  const records = incoming.map((row) => {
    validateOrderPlanRecord(ownerId, row);
    if (!Number.isSafeInteger(row.server_revision) || row.server_revision < 1)
      throw new Error(CORRUPT);
    return row;
  });
  const storage = browserStorage();
  const ownerPrefix = prefix(ownerId);
  const remoteKeys = new Set(records.map((row) => row.record_key));
  if (remoteKeys.size !== records.length) throw new Error(CORRUPT);
  // Preflight conflicting frozen payloads before applying even a single row.
  for (const row of records.filter((item) => item.record_kind === 'plan')) {
    const raw = read(storage, `${ownerPrefix}${row.record_key}`);
    const id = row.record.id;
    if (
      raw !== null &&
      read(storage, `${ownerPrefix}removed:${id}`) === null &&
      !remoteKeys.has(`removed:${id}`) &&
      !samePlanRecord(row, { ...row, record: JSON.parse(raw) })
    ) {
      throw new Error(
        'A saved plan conflicts with its cloud snapshot. Existing browser data has been preserved.',
      );
    }
  }
  let changed = false;
  const put = (key, value) => {
    const raw = read(storage, key);
    if (
      raw !== null &&
      samePlanRecord(
        { user_id: ownerId, record_key: key, record_kind: 'plan', record: JSON.parse(raw) },
        { user_id: ownerId, record_key: key, record_kind: 'plan', record: value },
      )
    )
      return;
    write(storage, key, value);
    changed = true;
  };
  for (const row of records.filter((item) => item.record_kind === 'removed')) {
    const key = `${ownerPrefix}${row.record_key}`;
    if (read(storage, key) === null) put(key, row.record);
  }
  for (const row of records.filter((item) => item.record_kind === 'plan')) {
    const id = row.record.id;
    if (read(storage, `${ownerPrefix}removed:${id}`) === null)
      put(`${ownerPrefix}${row.record_key}`, row.record);
  }
  const reviews = new Map();
  for (const row of records.filter((item) => item.record_kind === 'review')) {
    const { id } = row.record;
    if ((reviews.get(id)?.server_revision ?? 0) < row.server_revision) reviews.set(id, row);
  }
  for (const [id, row] of reviews) {
    if (read(storage, `${ownerPrefix}removed:${id}`) !== null) continue;
    const key = `${ownerPrefix}review:${id}`;
    const raw = read(storage, key);
    if (raw !== null) {
      const local = parse(reviewSchema, raw);
      if (!local.eventId || !remoteKeys.has(`review:${id}:${local.eventId}`)) continue;
    }
    put(key, row.record);
  }
  if (changed) notify(ownerId);
}
