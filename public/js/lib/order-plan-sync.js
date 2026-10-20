/**
 * Syncs browser order plans with their private cloud copy (append-only, per
 * member) and reports sync status.
 */
import { api, sessionIdentity } from '../core/api.js';

import {
  MAX_PLAN_RECORDS,
  exportOrderPlanRecords,
  mergeOrderPlanRecords,
  samePlanRecord,
  subscribeOrderPlans,
  validateOrderPlanRecord,
} from '../../../shared/order-plans.js';

const PAGE_SIZE = 50;
const MAX_RECORDS = MAX_PLAN_RECORDS;
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const STOPPED = 'The account session changed before plan sync finished.';
const INCOMPLETE = 'Could not verify the complete cloud plan history. Retry sync before exporting.';

/** Same-origin REST transport; the server re-validates every appended record. */
export const orderPlanTransport = {
  async requireActiveOwner(ownerId) {
    let snapshot;
    try {
      snapshot = await api('/api/username');
    } catch (error) {
      if (error?.status === 409)
        throw new Error(
          'The signed-in account changed. Reopen this workspace before syncing plans.',
        );
      if (error?.status === 401 || error?.status === 403)
        throw new Error(
          'Active workspace access is required to sync plans. Sign in again or contact your administrator.',
        );
      throw new Error(
        'Could not verify your sign-in. Plans remain in this browser; reconnect or sign in again, then retry sync.',
      );
    }
    void snapshot;
    if (!ownerId || !sessionIdentity()) {
      throw new Error('The signed-in account changed. Reopen this workspace before syncing plans.');
    }
  },
  async page(ownerId, offset, limit) {
    try {
      const result = await api(`/api/order-plans?offset=${offset}&limit=${limit}`);
      return { rows: result?.rows ?? [], count: result?.count ?? null };
    } catch {
      throw new Error('Cloud plans could not be read. Check your connection and workspace access.');
    }
  },
  /** Only the records after `revision` (plus the total count), for a sync after the first. */
  async pageAfter(ownerId, revision, limit) {
    try {
      const result = await api(`/api/order-plans?after=${revision}&limit=${limit}`);
      return { rows: result?.rows ?? [], count: result?.count ?? null };
    } catch {
      throw new Error('Cloud plans could not be read. Check your connection and workspace access.');
    }
  },
  async insert(row) {
    try {
      await api('/api/order-plans', {
        method: 'POST',
        body: {
          user_id: row.user_id,
          record_key: row.record_key,
          record_kind: row.record_kind,
          record: row.record,
        },
      });
    } catch {
      throw new Error(
        'Plans remain in this browser. Cloud sync failed; check your connection and workspace access, then retry.',
      );
    }
  },
  /** No separate timer: the sync worker below already refreshes every minute and on focus. */
  subscribe() {
    return () => {};
  },
};

/**
 * Cloud history already read and verified in this tab, per owner, so later syncs only download
 * new records instead of the whole history every minute.
 */
const cloudCache = new Map();

/** Checks one page against what was read so far; throws INCOMPLETE on any inconsistency. */
function acceptPage(ownerId, state, page, total) {
  if (
    !Number.isSafeInteger(page.count) ||
    page.count < 0 ||
    page.count > MAX_RECORDS ||
    (total !== null && total !== page.count) ||
    !Array.isArray(page.rows) ||
    page.rows.length > PAGE_SIZE ||
    state.rows.length + page.rows.length > page.count ||
    (!page.rows.length && state.rows.length < page.count)
  )
    throw new Error(INCOMPLETE);
  for (const row of page.rows) {
    validateOrderPlanRecord(ownerId, row);
    if (
      !Number.isSafeInteger(row.server_revision) ||
      row.server_revision <= state.revision ||
      state.keys.has(row.record_key)
    ) {
      throw new Error(INCOMPLETE);
    }
    state.bytes += new TextEncoder().encode(JSON.stringify(row)).length;
    if (state.bytes > MAX_SNAPSHOT_BYTES)
      throw new Error(
        'Cloud plan history exceeds the safe download limit. Contact the workspace administrator; no records were discarded.',
      );
    state.revision = row.server_revision;
    state.keys.add(row.record_key);
    state.rows.push(row);
  }
  return page.count;
}

/**
 * Downloads only records newer than the cached ones. Records are append-only, so the cache plus
 * the new rows must add up to the server's count; if not (e.g. a slower insert committed an older
 * revision), the caller falls back to a full read.
 */
async function readNewRecords(ownerId, transport, current, cached) {
  const state = { ...cached, rows: [...cached.rows], keys: new Set(cached.keys) };
  let total = null;
  do {
    if (!current()) throw new Error(STOPPED);
    const page = await transport.pageAfter(ownerId, state.revision, PAGE_SIZE);
    if (!current()) throw new Error(STOPPED);
    total = acceptPage(ownerId, state, page, total);
  } while (state.rows.length < total);
  return state;
}

/**
 * Every page is counted; lower project row caps cannot silently truncate history. After the first
 * complete read, only new records are downloaded (when the transport supports it).
 */
export async function readCloudOrderPlanRecords(ownerId, transport, current) {
  const cached = cloudCache.get(ownerId);
  if (cached && transport.pageAfter) {
    try {
      const state = await readNewRecords(ownerId, transport, current, cached);
      cloudCache.set(ownerId, state);
      return [...state.rows];
    } catch (error) {
      if (error?.message === STOPPED) throw error;
      cloudCache.delete(ownerId);
    }
  }
  const rows = await readAllRecords(ownerId, transport, current);
  if (transport.pageAfter) {
    cloudCache.set(ownerId, {
      rows: [...rows],
      keys: new Set(rows.map((row) => row.record_key)),
      bytes: rows.reduce(
        (sum, row) => sum + new TextEncoder().encode(JSON.stringify(row)).length,
        0,
      ),
      revision: rows.at(-1)?.server_revision ?? 0,
    });
  }
  return rows;
}

async function readAllRecords(ownerId, transport, current) {
  const rows = [];
  const keys = new Set();
  let total = null;
  let bytes = 0;
  let revision = 0;
  do {
    if (!current()) throw new Error(STOPPED);
    const page = await transport.page(ownerId, rows.length, PAGE_SIZE);
    if (!current()) throw new Error(STOPPED);
    if (
      !Number.isSafeInteger(page.count) ||
      page.count === null ||
      page.count < 0 ||
      page.count > MAX_RECORDS ||
      (total !== null && total !== page.count) ||
      !Array.isArray(page.rows) ||
      page.rows.length > PAGE_SIZE ||
      rows.length + page.rows.length > page.count ||
      (!page.rows.length && rows.length < page.count)
    )
      throw new Error(INCOMPLETE);
    total = page.count;
    for (const row of page.rows) {
      validateOrderPlanRecord(ownerId, row);
      if (
        !Number.isSafeInteger(row.server_revision) ||
        row.server_revision <= revision ||
        keys.has(row.record_key)
      ) {
        throw new Error(INCOMPLETE);
      }
      bytes += new TextEncoder().encode(JSON.stringify(row)).length;
      if (bytes > MAX_SNAPSHOT_BYTES)
        throw new Error(
          'Cloud plan history exceeds the safe download limit. Contact the workspace administrator; no records were discarded.',
        );
      revision = row.server_revision;
      keys.add(row.record_key);
      rows.push(row);
    }
  } while (rows.length < total);
  return rows;
}

/** Acknowledgment follows a complete read-back, never an optimistic upload. */
export async function synchronizeOrderPlans(ownerId, transport, current) {
  if (!current()) throw new Error(STOPPED);
  await transport.requireActiveOwner(ownerId);
  if (!current()) throw new Error(STOPPED);
  const local = exportOrderPlanRecords(ownerId);
  let remote = await readCloudOrderPlanRecords(ownerId, transport, current);
  const known = new Map(remote.map((row) => [row.record_key, row]));
  let uploaded = false;
  for (const row of local) {
    if (!current()) throw new Error(STOPPED);
    const planId = row.record.id;
    if (row.record_kind !== 'removed' && known.has(`removed:${planId}`)) continue;
    const existing = known.get(row.record_key);
    if (existing) {
      if (!samePlanRecord(row, existing))
        throw new Error(
          'A saved plan conflicts with its cloud snapshot. Neither copy was overwritten.',
        );
      continue;
    }
    // Do not upload a stale plan or review after learning of a permanent removal.
    await transport.insert(row);
    if (!current()) throw new Error(STOPPED);
    uploaded = true;
  }
  if (uploaded) remote = await readCloudOrderPlanRecords(ownerId, transport, current);
  await transport.requireActiveOwner(ownerId);
  if (!current()) throw new Error(STOPPED);
  const acknowledged = new Map(remote.map((row) => [row.record_key, row]));
  // An ignored UUID conflict must be checked before merging or reporting success.
  for (const row of local) {
    const planId = row.record.id;
    if (row.record_kind !== 'removed' && acknowledged.has(`removed:${planId}`)) continue;
    const confirmed = acknowledged.get(row.record_key);
    if (!confirmed || !samePlanRecord(row, confirmed))
      throw new Error(
        'Cloud plan acknowledgment could not be verified. Existing browser records remain available; retry sync.',
      );
  }
  mergeOrderPlanRecords(ownerId, remote);
  // A local edit made while requests were pending requires another pass.
  return exportOrderPlanRecords(ownerId).every((row) => {
    const confirmed = acknowledged.get(row.record_key);
    return confirmed !== undefined && samePlanRecord(row, confirmed);
  });
}

const sessions = new Map();

/** Shared per-account worker avoids one cloud session per mounted consumer. */
export function subscribeOrderPlanSync(ownerId, listener, transport = orderPlanTransport) {
  let session = sessions.get(ownerId);
  if (!session) {
    let active = true;
    let running = false;
    let again = false;
    const listeners = new Set();
    const created = {
      listeners,
      status: { state: 'syncing', error: null, lastSyncedAt: null },
      retry: () => {},
      dispose: () => {},
    };
    const publish = (status) => {
      if (!active) return;
      created.status = status;
      listeners.forEach((receive) => receive(status));
    };
    const run = async () => {
      if (!active) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      publish({ ...created.status, state: 'syncing', error: null });
      try {
        let passes = 0;
        do {
          again = false;
          const complete = await synchronizeOrderPlans(ownerId, transport, () => active);
          if (!active) return;
          again ||= !complete;
          if (++passes >= 8 && again)
            throw new Error(
              'Plans are changing on another device. Local changes are saved; retry sync shortly.',
            );
        } while (again && active);
        publish({ state: 'synced', error: null, lastSyncedAt: new Date().toISOString() });
      } catch (reason) {
        publish({
          ...created.status,
          state: 'error',
          error: reason instanceof Error ? reason.message : 'Cloud plan sync failed. Retry sync.',
        });
      } finally {
        running = false;
      }
    };
    const retry = () => {
      void run();
    };
    const local = subscribeOrderPlans(ownerId, retry);
    const remote = transport.subscribe(
      ownerId,
      retry,
      () => {
        publish({
          ...created.status,
          state: 'error',
          error: 'Live plan updates are disconnected. Retry sync to read the latest cloud plans.',
        });
      },
      () => {
        publish({
          ...created.status,
          state: 'error',
          error: 'The signed-in account changed. Reopen this workspace before syncing plans.',
        });
        active = false;
        queueMicrotask(() => created.dispose());
      },
    );
    // Hidden tabs do not poll; they sync again when shown (see `visible` below).
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') retry();
    }, 60000);
    const visible = () => {
      if (document.visibilityState === 'visible') retry();
    };
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    document.addEventListener('visibilitychange', visible);
    created.retry = retry;
    created.dispose = () => {
      active = false;
      local();
      remote();
      window.clearInterval(interval);
      window.removeEventListener('online', retry);
      window.removeEventListener('focus', retry);
      document.removeEventListener('visibilitychange', visible);
    };
    session = created;
    sessions.set(ownerId, session);
    // Register the first observer before beginning asynchronous work.
    queueMicrotask(retry);
  }
  session.listeners.add(listener);
  listener(session.status);
  const subscribed = session;
  return {
    retry: () => {
      if (sessions.get(ownerId) === subscribed) subscribed.retry();
    },
    unsubscribe: () => {
      subscribed.listeners.delete(listener);
      if (!subscribed.listeners.size) {
        subscribed.dispose();
        if (sessions.get(ownerId) === subscribed) sessions.delete(ownerId);
      }
    },
  };
}
