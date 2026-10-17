/**
 * Calculator page data, form state and the input/error element registries.
 */
import { pageData } from '../../core/dom.js';
import { NSE_SYMBOL_RE } from '../../../../shared/ai-schemas.js';

export const data = pageData();
export const { accountId } = data;
export const { watchlist, strategies, rules, settings, portfolioBalance } = data.workspace;
export const requestedSymbol = String(data.query?.symbol ?? '').toUpperCase();

export const fields = {
  direction: 'Long',
  accountSize: String(portfolioBalance),
  availableCapital: '',
  riskPercent: '1',
  entryPrice: '',
  stopLoss: '',
  takeProfit: '',
  quantity: '',
  product: 'MIS',
  marginPercent: '100',
  estimatedRoundTripCharges: '',
  priceMode: 'percent',
  stopDistancePercent: '1',
  rewardMultiple: '3',
};
export const state = {
  symbol: NSE_SYMBOL_RE.test(requestedSymbol) ? requestedSymbol : (watchlist[0]?.symbol ?? ''),
  strategyId: '',
  rewardPreset: '3',
  customReward: '3',
  edited: {},
  quote: null,
  quoteState: '',
  entryEdited: false,
  saveError: null,
  prepared: false,
  syncing: false,
  syncMessage: '',
  capitalRevision: 0,
};
// The order-plan store, created at start-up by the page entry (calculator.js).
export const storeRef = { current: null };

export const errorElements = {};
export const inputs = {};
