/**
 * Reports page: the planning report (from saved order plans) and the journal
 * performance report with AI insights and PDF download.
 *
 * The page is split into public/js/pages/reports/; this entry wires the source
 * switcher, creates the order-plan store and paints both reports.
 */
import { $$ } from '../core/dom.js';
import { createOrderPlanStore } from '../lib/order-plans-store.js';
import { accountId, data } from './reports/shared.js';
import { setSource } from './reports/source.js';
import { paintPlanning, planStoreRef } from './reports/planning.js';
import { paintJournal } from './reports/journal-report.js';

for (const control of $$('[data-source]'))
  control.addEventListener('click', () => setSource(control.dataset.source));

if (accountId) planStoreRef.current = createOrderPlanStore(accountId, paintPlanning);
paintPlanning();
paintJournal();
if (data.query?.source === 'journal') setSource('journal');
