/**
 * Authentication routes under /auth (sign-in, recovery, Google, sign-out).
 */
import { Router } from 'express';
import { asyncHandler as wrap } from '../services/errors.js';
import * as auth from '../controllers/auth.controller.js';
import * as mfa from '../controllers/mfa.controller.js';

const router = Router();

router.post('/login', wrap(auth.login));
router.post('/signup', wrap(auth.signup));
router.post('/logout', wrap(auth.logout));
router.post('/recover', wrap(auth.recover));
router.post('/link', wrap(auth.exchangeLink));
router.post('/password', wrap(auth.setPassword));
router.get('/google', auth.googleStart);
router.get('/google/callback', wrap(auth.googleCallback));

router.get('/mfa/factors', wrap(mfa.listFactors));
router.post('/mfa/admin-code', wrap(mfa.sendAdminSetupCode));
router.post('/mfa/enroll', wrap(mfa.enroll));
router.post('/mfa/verify', wrap(mfa.verify));
router.post('/mfa/unenroll', wrap(mfa.unenroll));

export default router;
