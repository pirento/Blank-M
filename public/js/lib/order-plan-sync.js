/**
 * Syncs browser order plans with their private cloud copy (append-only, per
 * member) and reports sync status.
 */
import { api, sessionIdentity } from '../core/api.js';

import {
  exportOrderPlanRecords,
  mergeOrderPlanRecords,
  samePlanRecord,
  subscribeOrderPlans,
  validateOrderPlanRecord,
} from '../../../shared/order-plans.js';

const PAGE_SIZE = 50;
const MAX_RECORDS = 10000;
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
  /** Periodic refresh replaces database push notifications. */
  subscribe(_ownerId, changed) {
    const timer = window.setInterval(changed, 15_000);
    return () => window.clearInterval(timer);
  },
};

/** Every page is counted; lower project row caps cannot silently truncate history. */
export async function readCloudOrderPlanRecords(ownerId, transport, current) {
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
    const interval = window.setInterval(retry, 60000);
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
