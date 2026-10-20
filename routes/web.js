/**
 * Server-rendered page routes.
 */
import { Router } from 'express';
import { asyncHandler as wrap } from '../services/errors.js';
import { requirePageAuth } from '../middleware/auth.js';
import * as pages from '../controllers/pages.controller.js';

const router = Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

router.get('/', pages.landing);
router.get('/login', wrap(pages.login));
router.get('/signup', wrap(pages.signup));
router.get('/invite', pages.invite);
router.get('/:page(terms|privacy|refunds|contact)', wrap(pages.legal));
router.get('/auth/link/:purpose(activate|recover)', pages.authLink);
router.get('/share/:token', wrap(pages.sharedJournal));

const CHARTS = ['chart.umd.min.js'];
const PDF = ['jspdf.umd.min.js', 'html-to-image.js'];

// [path, view, workspace parts the page uses, vendor scripts, Premium feature]. Loading only the
// parts a page needs keeps large journals fast; the list is checked by the
// end-to-end smoke test, which opens every page.
const WORKSPACE_PAGES = [
  [
    '/dashboard',
    'dashboard',
    ['trades', 'strategies', 'rules', 'settings', 'portfolioBalance'],
    CHARTS,
  ],
  ['/today', 'today', ['trades', 'strategies', 'rules', 'settings', 'portfolioBalance']],
  ['/watchlist', 'watchlist', []],
  ['/calculator', 'calculator', ['strategies', 'rules', 'settings', 'portfolioBalance']],
  ['/orders', 'orders', ['rules', 'settings']],
  ['/transactions', 'transactions', ['trades', 'strategies', 'settings']],
  ['/reports', 'reports', ['trades', 'strategies', 'rules', 'chatMessages'], PDF, 'reports'],
  ['/strategy', 'strategy', ['trades', 'strategies', 'rules']],
  ['/analytics', 'analytics', ['trades', 'strategies', 'rules', 'chatMessages'], [], 'ai'],
  ['/settings', 'settings', ['settings']],
  ['/billing', 'billing', []],
  ['/chart', 'chart', []],
  ['/journal', 'journal', ['trades', 'strategies', 'rules', 'settings']],
  ['/import', 'import', ['trades', 'settings']],
  ['/backtest', 'backtest', ['trades', 'strategies', 'rules', 'settings'], CHARTS, 'backtest'],
  ['/rules', 'rules', ['rules']],
  ['/insights', 'insights', ['trades', 'strategies'], CHARTS],
  ['/tax', 'tax', ['trades'], [], 'reports'],
  ['/paper', 'paper', [], [], 'paper'],
  ['/options', 'options', [], [], 'options'],
];
for (const [path, view, data, vendor, feature] of WORKSPACE_PAGES) {
  router.get(path, requirePageAuth, wrap(pages.workspacePage(view, { data, vendor, feature })));
}
// Member management moved to the admin panel.
router.get('/users', (_req, res) => res.redirect(301, '/admin/members'));

router.use(pages.notFound);

export default router;
