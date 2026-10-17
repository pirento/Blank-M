/**
 * Overview page: market workspace (watchlist quote and chart), recent order
 * plans, the getting-started checklist and the trading record with charts.
 * Every figure comes from shared/pnl.js; no mock data. Empty accounts render
 * empty states and provider freshness is never implied.
 *
 * The page is split into public/js/pages/dashboard/; this entry paints each
 * part and starts the first loads.
 */
import { createOrderPlanStore } from '../lib/order-plans-store.js';
import { data } from './dashboard/shared.js';
import {
  loadBrokerStatus,
  loadQuote,
  paintChartSurface,
  paintInstruments,
} from './dashboard/market.js';
import { paintPlans } from './dashboard/plans.js';
import { paintChecklist } from './dashboard/checklist.js';
import { paintRecord } from './dashboard/record.js';
import { paintRisk } from './dashboard/risk.js';

paintInstruments();
paintChartSurface();
void loadQuote();
void loadBrokerStatus();
createOrderPlanStore(data.accountId, paintPlans);
paintRisk();
paintChecklist();
paintRecord();
