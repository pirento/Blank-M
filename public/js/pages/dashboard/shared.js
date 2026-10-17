/**
 * Dashboard page data from the server and shared constants.
 */
import { pageData } from '../../core/dom.js';

export const data = pageData();
export const { trades, rules, watchlist, settings, portfolioBalance } = data.workspace;
export const RANGES = ['7d', '30d', '90d', 'ytd', 'all'];
export const CHECKLIST_DISMISSED_KEY = 'blank_checklist_dismissed';
