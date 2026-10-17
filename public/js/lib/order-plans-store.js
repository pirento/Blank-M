/**
 * Order plans for one member in this browser, kept in sync with the cloud copy.
 */
import {
  loadOrderPlans,
  removeOrderPlan,
  saveOrderPlan,
  setOrderPlanReviewed,
  subscribeOrderPlans,
} from '../../../shared/order-plans.js';
import { subscribeOrderPlanSync } from './order-plan-sync.js';

function readPlans(accountId) {
  try {
    return { plans: loadOrderPlans(accountId), error: null };
  } catch (error) {
    return {
      plans: [],
      error: error instanceof Error ? error.message : 'Could not load saved plans in this browser.',
    };
  }
}

/**
 * Browser-local manual plans plus private cloud sync for one account.
 * `onChange` receives `{ plans, error, syncStatus }`.
 */
export function createOrderPlanStore(accountId, onChange) {
  let active = true;
  let state = { ...readPlans(accountId) };
  let syncStatus = { state: accountId ? 'syncing' : 'local', error: null, lastSyncedAt: null };
  const publish = () => {
    if (active) onChange?.({ ...state, syncStatus });
  };
  const reload = () => {
    state = { ...readPlans(accountId) };
    publish();
  };
  const unsubscribe = accountId?.trim() ? subscribeOrderPlans(accountId, reload) : () => {};
  const cloud = accountId?.trim()
    ? subscribeOrderPlanSync(accountId, (status) => {
        syncStatus = status;
        publish();
      })
    : null;

  const mutate = (operation) => {
    if (!accountId?.trim() || !active) {
      throw new Error('This account session is no longer active. Reopen the plan and try again.');
    }
    try {
      const value = operation(accountId);
      state = { ...readPlans(accountId) };
      publish();
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update saved plans.';
      state = { ...readPlans(accountId), error: message };
      publish();
      throw error;
    }
  };

  queueMicrotask(publish);
  return {
    get plans() {
      return state.plans;
    },
    get error() {
      return state.error;
    },
    get syncStatus() {
      return syncStatus;
    },
    retrySync: () => cloud?.retry(),
    savePlan: (draft) => mutate((ownerId) => saveOrderPlan(ownerId, draft)),
    removePlan: (id) => mutate((ownerId) => removeOrderPlan(ownerId, id)),
    setReviewed: (id, reviewed) => mutate((ownerId) => setOrderPlanReviewed(ownerId, id, reviewed)),
    dispose() {
      active = false;
      unsubscribe();
      cloud?.unsubscribe();
    },
  };
}

/** The status line shown wherever plans are listed. */
export function planSyncMessage(status) {
  return status.state === 'synced'
    ? 'Plans synced to your private account. They are available on your other signed-in devices.'
    : status.state === 'syncing'
      ? 'Plans are saved in this browser. Syncing your private cloud history…'
      : status.state === 'error'
        ? status.error
        : 'Sign in to sync plans across devices.';
}
