/**
 * The admin panel's pages under /admin, separate from the member workspace:
 * its own sign-in page, layout and navigation (config/nav.js ADMIN_PANEL_NAV).
 * The JSON endpoints these pages call live in routes/api.js under /api/admin.
 */
import { Router } from 'express';
import { requireAdminPage } from '../middleware/auth.js';
import * as adminPanel from '../controllers/admin-panel.controller.js';

const router = Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  // The panel is never shown inside another site's frame or indexed.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

router.get('/login', adminPanel.loginPage);
for (const [path, view, title, subtitle] of adminPanel.ADMIN_PAGES) {
  router.get(path, requireAdminPage, adminPanel.adminPage(view, title, subtitle));
}

export default router;
