/** Domain types shared across the app. All money values are in INR. */

/**
 * Brokerage and statutory charges for NSE intraday equity.
 *
 * Defaults follow the published discount-broker structure. Every rate is a
 * percentage (0.025 means 0.025%), so the numbers here read the same way they
 * do on a broker's charges page.
 */

export const DEFAULT_CHARGES = {
  enabled: true,
  brokeragePercent: 0.03,
  brokerageMaxPerOrder: 20,
  sttPercent: 0.025,
  exchangeTxnPercent: 0.00297,
  sebiPercent: 0.0001,
  gstPercent: 18,
  stampDutyPercent: 0.003,
};

/** Per-user account settings, stored in Firestore so they follow the user. */

export const DEFAULT_ACCOUNT_SETTINGS = {
  openingBalance: 100000,
  charges: DEFAULT_CHARGES,
};
