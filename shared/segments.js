/**
 * Market segments for journal trades: cash equity, futures and options.
 * Futures and options use their own charge rates (Settings → Charges), and
 * record the contract details (lot size, expiry, strike, call/put). Quantity
 * is always in units (lots × lot size), so P&L uses the same formula.
 */

export const SEGMENTS = [
  { value: 'EQ', label: 'Equity' },
  { value: 'FUT', label: 'Futures' },
  { value: 'OPT', label: 'Options' },
];
export const SEGMENT_VALUES = SEGMENTS.map((segment) => segment.value);
/** Display label for a segment value; unknown or missing values read as 'Equity'. */
export const segmentLabel = (value) =>
  SEGMENTS.find((segment) => segment.value === value)?.label ?? 'Equity';

/**
 * Default F&O rates (percentages, like DEFAULT_CHARGES), following a discount
 * broker's published NSE F&O structure. Rates change; members can edit them.
 * Options brokerage is a flat ₹20 per order: 100% of the order value, capped
 * at ₹20, gives exactly that for any premium above ₹20.
 */
export const DEFAULT_FO_CHARGES = {
  futures: {
    enabled: true,
    brokeragePercent: 0.03,
    brokerageMaxPerOrder: 20,
    sttPercent: 0.02,
    exchangeTxnPercent: 0.00173,
    sebiPercent: 0.0001,
    gstPercent: 18,
    stampDutyPercent: 0.002,
  },
  options: {
    enabled: true,
    brokeragePercent: 100,
    brokerageMaxPerOrder: 20,
    sttPercent: 0.1,
    exchangeTxnPercent: 0.03503,
    sebiPercent: 0.0001,
    gstPercent: 18,
    stampDutyPercent: 0.003,
  },
};

/** The charge rates for a trade's segment from account settings. */
export function chargesForSegment(settings, segment = 'EQ') {
  if (segment === 'FUT') return settings.foCharges?.futures ?? DEFAULT_FO_CHARGES.futures;
  if (segment === 'OPT') return settings.foCharges?.options ?? DEFAULT_FO_CHARGES.options;
  return settings.charges;
}

/** Segment of a broker trading symbol: …FUT is a future, …CE / …PE an option. */
export function segmentOfSymbol(symbol, exchange) {
  if (!['NFO', 'BFO'].includes(exchange)) return 'EQ';
  if (/FUT$/.test(symbol)) return 'FUT';
  if (/\d(CE|PE)$/.test(symbol)) return 'OPT';
  return null;
}

/**
 * Validates and normalises contract details for a segment. Returns
 * { values, errors }: values holds segment, lotSize, expiry, strike and
 * optionType (null where they do not apply); errors maps field → message.
 */
export function contractDetails(input = {}) {
  const segment = input.segment || 'EQ';
  const errors = {};
  const values = { segment, lotSize: null, expiry: null, strike: null, optionType: null };
  if (!SEGMENT_VALUES.includes(segment)) {
    errors.segment = 'Choose equity, futures or options.';
    return { values, errors };
  }
  if (segment === 'EQ') return { values, errors };

  const lotSize = Number(input.lotSize);
  if (input.lotSize !== null && input.lotSize !== undefined && input.lotSize !== '') {
    if (!Number.isInteger(lotSize) || lotSize < 1 || lotSize > 100000)
      errors.lotSize = 'Lot size must be a whole number of units.';
    else values.lotSize = lotSize;
  }
  if (input.expiry) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiry) || Number.isNaN(Date.parse(input.expiry)))
      errors.expiry = 'Enter a valid expiry date.';
    else values.expiry = input.expiry;
  }
  if (segment === 'OPT') {
    if (!['CE', 'PE'].includes(input.optionType))
      errors.optionType = 'Choose call (CE) or put (PE).';
    else values.optionType = input.optionType;
    const strike = Number(input.strike);
    if (input.strike !== null && input.strike !== undefined && input.strike !== '') {
      if (!Number.isFinite(strike) || strike <= 0)
        errors.strike = 'Strike must be a positive price.';
      else values.strike = Math.round(strike * 100) / 100;
    }
  }
  return { values, errors };
}

/** Quantity must be whole lots when a lot size is known. */
export function lotProblem(quantity, lotSize) {
  if (!lotSize) return null;
  return Number(quantity) % lotSize === 0
    ? null
    : `Quantity must be a multiple of the lot size (${lotSize}).`;
}
