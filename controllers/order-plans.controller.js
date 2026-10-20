/**
 * Cloud history for order plans: list appended records and append a new one.
 */
import { z } from 'zod';
import { OrderPlanRecord, nextSequence } from '../models/index.js';
import {
  MAX_PLAN_RECORDS,
  validateOrderPlanRecord,
  samePlanRecord,
} from '../shared/order-plans.js';
import { HttpError } from '../services/errors.js';

const MAX_PAGE = 50;
const MAX_RECORD_BYTES = 262144;

function toCloudRow(row) {
  return {
    user_id: row.userId,
    record_key: row.recordKey,
    record_kind: row.recordKind,
    record: row.record,
    server_revision: row.serverRevision,
  };
}

/**
 * Exact-count pages in server-revision order, so history cannot be silently truncated. With
 * `after`, only records newer than that revision (a browser that already has the rest).
 */
export async function listRecords(req, res) {
  const query = z
    .object({
      offset: z.coerce.number().int().min(0).default(0),
      after: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(MAX_PAGE),
    })
    .safeParse(req.query);
  if (!query.success) throw new HttpError('Invalid plan history page.', 400);
  const userId = req.member.userId;
  const { offset, after, limit } = query.data;
  const page =
    after === undefined
      ? OrderPlanRecord.find({ userId }).sort({ serverRevision: 1 }).skip(offset)
      : OrderPlanRecord.find({ userId, serverRevision: { $gt: after } }).sort({
          serverRevision: 1,
        });
  const [count, rows] = await Promise.all([
    OrderPlanRecord.countDocuments({ userId }),
    page.limit(limit).lean(),
  ]);
  res.json({ rows: rows.map(toCloudRow), count });
}

/**
 * Append-only insert. The frozen plan, its exact economics and its owner are
 * validated with the same rules the browser applies; existing keys are never
 * updated (a duplicate is ignored, and the client verifies the read-back).
 */
export async function appendRecord(req, res) {
  const userId = req.member.userId;
  const body = req.body ?? {};
  const candidate = {
    user_id: userId,
    record_key: body.record_key,
    record_kind: body.record_kind,
    record: body.record,
  };
  if (body.user_id !== undefined && body.user_id !== userId) {
    throw new HttpError('Active plan ownership is required.', 403);
  }
  if (Buffer.byteLength(JSON.stringify(body.record ?? null), 'utf8') > MAX_RECORD_BYTES) {
    throw new HttpError('Invalid or oversized frozen plan record.', 400);
  }
  let valid;
  try {
    valid = validateOrderPlanRecord(userId, candidate);
  } catch {
    throw new HttpError('Invalid or oversized frozen plan record.', 400);
  }
  const existing = await OrderPlanRecord.findOne({ userId, recordKey: valid.record_key }).lean();
  if (existing) {
    res.json({ inserted: false, matches: samePlanRecord(valid, toCloudRow(existing)) });
    return;
  }
  if ((await OrderPlanRecord.countDocuments({ userId })) >= MAX_PLAN_RECORDS) {
    throw new HttpError(
      `Plan history is full (${MAX_PLAN_RECORDS.toLocaleString('en-IN')} records). Contact the administrator.`,
      409,
    );
  }
  try {
    await OrderPlanRecord.create({
      userId,
      recordKey: valid.record_key,
      recordKind: valid.record_kind,
      record: valid.record,
      serverRevision: await nextSequence('order_plan_records'),
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    res.json({ inserted: false });
    return;
  }
  res.status(201).json({ inserted: true });
}
