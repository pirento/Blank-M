/**
 * Upstox, Fyers and Angel One endpoints (read-only): status, connect (OAuth
 * login for Upstox and Fyers, a SmartAPI login form for Angel One),
 * disconnect, and today's fills previewed and added to the journal. Each
 * broker gets the same handlers from brokerHandlers(provider).
 */
import { authenticatedApi } from '../middleware/auth.js';
import { angelStatus, connectAngel } from '../services/broker/angel.js';
import { forgetBrokerToken } from '../services/broker/broker-api.js';
import { importFills, previewFills } from '../services/broker/fills-journal.js';
import { secureBrokerResponse } from '../services/broker/flow.js';
import {
  connectFyers,
  fyersAuthorizeUrl,
  fyersConfigured,
  fyersStatus,
} from '../services/broker/fyers.js';
import { beginOAuth, finishOAuth } from '../services/broker/oauth.js';
import {
  connectUpstox,
  upstoxAuthorizeUrl,
  upstoxConfigured,
  upstoxStatus,
} from '../services/broker/upstox.js';
import { HttpError } from '../services/errors.js';
import { createLogger, errorName } from '../services/logger.js';
import { reserveAttempts } from '../services/rate-window.js';

const log = createLogger('brokers');
const noRecheck = async () => undefined;

const BROKERS = {
  upstox: {
    label: 'Upstox',
    status: upstoxStatus,
    oauth: {
      configured: upstoxConfigured,
      authorizeUrl: upstoxAuthorizeUrl,
      codeParam: 'code',
      connect: connectUpstox,
    },
  },
  fyers: {
    label: 'Fyers',
    status: fyersStatus,
    oauth: {
      configured: fyersConfigured,
      authorizeUrl: fyersAuthorizeUrl,
      // Fyers also sends `code`, which is its HTTP-style status (200), not the login code.
      codeParam: 'auth_code',
      connect: connectFyers,
    },
  },
  angel: { label: 'Angel One', status: angelStatus, connect: connectAngel },
};

async function connectQuota(provider, userId) {
  const quota = await reserveAttempts(
    [{ key: `${provider}-connect:${userId}`, limit: 10 }],
    60 * 60_000,
  );
  if (!quota.allowed) throw new HttpError('Too many connection attempts. Try again later.', 429);
}

/** The route handlers for one broker (`upstox`, `fyers` or `angel`). */
export function brokerHandlers(provider) {
  const broker = BROKERS[provider];
  const fillsQuota = async (userId) => {
    const quota = await reserveAttempts(
      [{ key: `${provider}-fills:${userId}`, limit: 30 }],
      10 * 60_000,
    );
    if (!quota.allowed)
      throw new HttpError(`Too many ${broker.label} reads. Wait a few minutes.`, 429);
  };
  return {
    /** GET /api/<broker>: connection status and whether the server has app keys (never the keys). */
    async status(req, res) {
      res.json(await broker.status(req.member.userId));
    },

    /** POST /api/<broker>/authorize: starts the OAuth login and returns the broker's login URL. */
    async authorize(req, res) {
      if (!broker.oauth.configured()) {
        throw new HttpError(`The administrator has not set ${broker.label} app keys yet.`, 503);
      }
      await connectQuota(provider, req.member.userId);
      res.json({ url: broker.oauth.authorizeUrl(await beginOAuth(req, provider)) });
    },

    /**
     * GET /api/<broker>/callback: the broker's redirect. Checks the state against this
     * browser's session and member, stores the token, then returns to Settings with
     * ?broker=<broker>&result=connected|failed.
     */
    async callback(req, res) {
      secureBrokerResponse(res);
      let result = 'connected';
      try {
        const { userId } = authenticatedApi(req);
        await finishOAuth(req, provider, userId, req.query.state);
        const code = req.query[broker.oauth.codeParam];
        if (req.query.error || typeof code !== 'string') {
          throw new HttpError(`${broker.label} did not return a login code.`, 400);
        }
        await broker.oauth.connect(userId, code);
      } catch (error) {
        log.warn('broker login failed', { broker: provider, error: errorName(error) });
        result = 'failed';
      }
      res.redirect(303, `/settings?broker=${provider}&result=${result}`);
    },

    /** POST /api/angel/connect: logs in with the member's SmartAPI details (10 tries an hour). */
    async connect(req, res) {
      await connectQuota(provider, req.member.userId);
      res.json(await broker.connect(req.member.userId, req.body));
    },

    /** POST /api/<broker>/disconnect: forgets the token and account binding. */
    async disconnect(req, res) {
      await forgetBrokerToken(req.member.userId, provider);
      res.json(await broker.status(req.member.userId));
    },

    /** GET /api/<broker>/fills: today's fills paired into round trips, not yet saved. */
    async fills(req, res) {
      await fillsQuota(req.member.userId);
      res.json(await previewFills(req.member.userId, noRecheck, provider));
    },

    /** POST /api/<broker>/fills/import { ids }: adds the chosen round trips to the journal. */
    async importToJournal(req, res) {
      await fillsQuota(req.member.userId);
      res.json(await importFills(req.member.userId, noRecheck, req.body?.ids, provider));
    },
  };
}
