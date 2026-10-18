/**
 * Server-rendered page routes.
 */
import { Router } from 'express';
import { asyncHandler as wrap } from '../services/errors.js';
import { requirePageAdmin, requirePageAuth } from '../middleware/auth.js';
import * as pages from '../controllers/pages.controller.js';

const router = Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

router.get('/', pages.landing);
router.get('/login', pages.login);
router.get('/invite', pages.invite);
router.get('/auth/link/:purpose(activate|recover)', pages.authLink);
router.get('/share/:token', wrap(pages.sharedJournal));

const CHARTS = ['chart.umd.min.js'];
const PDF = ['jspdf.umd.min.js', 'html-to-image.js'];

// [path, view, workspace parts the page uses, vendor scripts]. Loading only the
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
  ['/reports', 'reports', ['trades', 'strategies', 'rules', 'chatMessages'], PDF],
  ['/strategy', 'strategy', ['trades', 'strategies', 'rules']],
  ['/analytics', 'analytics', ['trades', 'strategies', 'rules', 'chatMessages']],
  ['/settings', 'settings', ['settings']],
  ['/journal', 'journal', ['trades', 'strategies', 'rules', 'settings']],
  ['/import', 'import', ['trades', 'settings']],
  ['/backtest', 'backtest', ['trades', 'strategies', 'rules', 'settings'], CHARTS],
  ['/rules', 'rules', ['rules']],
  ['/insights', 'insights', ['trades', 'strategies'], CHARTS],
  ['/tax', 'tax', ['trades']],
  ['/paper', 'paper', []],
];
for (const [path, view, data, vendor] of WORKSPACE_PAGES) {
  router.get(path, requirePageAuth, wrap(pages.workspacePage(view, { data, vendor })));
}
router.get(
  '/users',
  requirePageAuth,
  requirePageAdmin,
  wrap(pages.workspacePage('users', { data: [] })),
);

router.use(pages.notFound);

export default router;
