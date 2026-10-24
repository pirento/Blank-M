/**
 * Admin-managed platform settings (API keys and switches). Values saved in the
 * admin panel are stored in MongoDB (secrets encrypted) and copied into
 * process.env, so every service that reads process.env picks them up without
 * knowing where they came from. A value from the panel wins over .env; clearing
 * it in the panel brings the .env value back.
 *
 * Flow: server start → applyPlatformSettings() → (every minute) refresh, so a
 * change made on one server process reaches the others within a minute.
 */
import { AdminAuditLog, PlatformSetting } from '../../models/index.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { HttpError } from '../errors.js';
import { createLogger, errorName } from '../logger.js';
import { loadPlan } from '../billing/plan.js';
import { env } from '../../config/env.js';
import { resetMailer } from '../mailer.js';
import { openAiApiKey } from '../ai/openai-key.js';
import { PLATFORM_SETTINGS, settingDefinition } from './settings-registry.js';

const log = createLogger('platform-settings');
const REFRESH_MS = 60_000;
const RAZORPAY_KEYS = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'];

/** The value each key had in .env before the panel overrode it (undefined = not set). */
const envValues = new Map();
/** Keys whose current process.env value came from the panel. */
const fromPanel = new Set();

function setEnv(key, value) {
  if (!envValues.has(key)) envValues.set(key, process.env[key]);
  const before = process.env[key];
  if (value === null) {
    const original = envValues.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
    fromPanel.delete(key);
  } else {
    process.env[key] = value;
    fromPanel.add(key);
  }
  // The mail transport is built once from SMTP_*; rebuild it after a change.
  if (key.startsWith('SMTP_') && before !== process.env[key]) resetMailer();
}

function storedValue(row) {
  const definition = settingDefinition(row._id);
  if (!definition) return null;
  if (definition.type !== 'secret') return row.value === null ? null : String(row.value);
  if (!row.secret?.ciphertext) return null;
  return decryptSecret(row.secret);
}

/**
 * Loads every panel setting from MongoDB into process.env. Keys removed from the
 * panel since the last load go back to their .env value. A value that cannot be
 * decrypted (for example after the encryption key changed) is skipped and logged.
 */
export async function applyPlatformSettings() {
  const rows = await PlatformSetting.find({
    _id: { $in: PLATFORM_SETTINGS.map((entry) => entry.key) },
  }).lean();
  const seen = new Set();
  for (const row of rows) {
    try {
      const value = storedValue(row);
      if (value === null) continue;
      seen.add(row._id);
      if (process.env[row._id] !== value || !fromPanel.has(row._id)) setEnv(row._id, value);
    } catch (error) {
      log.warn('platform setting could not be read', { key: row._id, error: errorName(error) });
    }
  }
  for (const key of [...fromPanel]) if (!seen.has(key)) setEnv(key, null);
}

/** Keeps this process in step with changes saved by other processes. */
export function startPlatformSettingsRefresh() {
  const timer = setInterval(() => {
    applyPlatformSettings().catch((error) =>
      log.warn('platform settings refresh failed', { error: errorName(error) }),
    );
  }, REFRESH_MS);
  timer.unref();
  return () => clearInterval(timer);
}

const lastFour = (value) => (value.length > 8 ? value.slice(-4) : '');

/**
 * Every editable setting grouped for the panel, with where its current value
 * comes from. Secrets are never returned — only whether they are set and their
 * last four characters.
 */
export async function describePlatformSettings() {
  const rows = new Map(
    (await PlatformSetting.find({}, { value: 1, hint: 1, updatedAt: 1, updatedBy: 1 }).lean()).map(
      (row) => [row._id, row],
    ),
  );
  const groups = new Map();
  for (const definition of PLATFORM_SETTINGS) {
    const row = rows.get(definition.key);
    // The OpenAI key may come from the older BLANK_OPENAI_API_KEY name in .env.
    const current =
      (definition.key === 'OPENAI_API_KEY' ? openAiApiKey() : undefined) ??
      process.env[definition.key];
    const source = fromPanel.has(definition.key) ? 'panel' : current?.trim() ? 'env' : 'unset';
    const secret = definition.type === 'secret';
    const item = {
      key: definition.key,
      label: definition.label,
      type: definition.type,
      help: definition.help ?? '',
      min: definition.min ?? null,
      max: definition.max ?? null,
      source,
      value: secret || source === 'unset' ? null : current,
      hint: secret && source !== 'unset' ? (row?.hint ?? lastFour(current ?? '')) : null,
      updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    };
    if (!groups.has(definition.group)) groups.set(definition.group, []);
    groups.get(definition.group).push(item);
  }
  return [...groups].map(([group, settings]) => ({ group, settings }));
}

/** A cleaned value for one setting, or null to clear it. Throws HttpError 400 when invalid. */
export function normalizeSettingValue(definition, raw) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return null;
  }
  const label = `${definition.group} → ${definition.label}`;
  switch (definition.type) {
    case 'boolean':
      if (raw === true || raw === 'true') return 'true';
      if (raw === false || raw === 'false') return 'false';
      throw new HttpError(`${label} must be on or off.`, 400);
    case 'number': {
      const number = Number(raw);
      if (
        !Number.isFinite(number) ||
        (definition.integer && !Number.isInteger(number)) ||
        (definition.min !== undefined && number < definition.min) ||
        (definition.max !== undefined && number > definition.max)
      ) {
        throw new HttpError(
          `${label} must be a number from ${definition.min} to ${definition.max}.`,
          400,
        );
      }
      return String(number);
    }
    case 'url': {
      let url;
      try {
        url = new URL(String(raw).trim());
      } catch {
        throw new HttpError(`${label} must be a full URL starting with https://.`, 400);
      }
      if (!['https:', 'http:'].includes(url.protocol)) {
        throw new HttpError(`${label} must start with https://.`, 400);
      }
      if (definition.pattern && !definition.pattern.test(url.toString())) {
        throw new HttpError(`${label} does not look right. ${definition.help ?? ''}`.trim(), 400);
      }
      return url.toString();
    }
    default: {
      const text = String(raw).trim();
      if (text.length > 2000 || /[\r\n]/.test(text)) {
        throw new HttpError(`${label} must be a single line of at most 2000 characters.`, 400);
      }
      if (definition.pattern && !definition.pattern.test(text)) {
        throw new HttpError(`${label} does not look right. Check it and paste it again.`, 400);
      }
      return text;
    }
  }
}

/**
 * A mistyped Google secret would lock every administrator out, so ask Google first: a bogus code
 * gets `invalid_grant` when the client ID and secret are right and `invalid_client` when not.
 */
async function assertGoogleClient(clientId, clientSecret) {
  let payload;
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'settings-check',
        client_id: clientId,
        client_secret: clientSecret,
        // As googleRedirectUri() in controllers/auth.controller.js builds it.
        redirect_uri: `${env.appUrl ? new URL(env.appUrl).origin : ''}/auth/google/callback`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    payload = await response.json().catch(() => null);
  } catch {
    payload = null;
  }
  if (payload?.error === 'invalid_client') {
    throw new HttpError(
      'Google rejected this client ID and secret. Copy both again from Google Cloud Console → Credentials.',
      409,
    );
  }
  if (payload?.error !== 'invalid_grant' && !payload?.access_token) {
    throw new HttpError(
      'Google could not be reached to check the client ID and secret. Try again in a minute.',
      503,
    );
  }
}

/**
 * Saves changes from the panel: `{ KEY: value }`, where an empty value clears the
 * panel value (the .env value applies again). Validates everything before
 * writing, encrypts secrets, writes an audit entry per key (never the secret
 * itself) and applies the result to this process immediately.
 */
export async function savePlatformSettings(actor, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new HttpError('Send the settings to change.', 400);
  }
  const entries = Object.entries(changes);
  if (!entries.length || entries.length > PLATFORM_SETTINGS.length) {
    throw new HttpError('Send the settings to change.', 400);
  }
  const cleaned = entries.map(([key, raw]) => {
    const definition = settingDefinition(key);
    if (!definition) throw new HttpError(`${key} cannot be changed from the admin panel.`, 400);
    return { definition, value: normalizeSettingValue(definition, raw) };
  });
  // Without these keys webhooks fail and paying members silently drop to free.
  const leavesPaymentsBroken = cleaned.some(({ definition: { key }, value }) => {
    if (value !== null || !RAZORPAY_KEYS.includes(key)) return false;
    const fallback = fromPanel.has(key) ? envValues.get(key) : process.env[key];
    return !fallback?.trim();
  });
  if (leavesPaymentsBroken && (await loadPlan()).enabled) {
    throw new HttpError('Switch billing off before removing the Razorpay keys.', 409);
  }
  // Administrators sign in only with Google: never save a change that turns it off.
  const after = (key) => {
    const change = cleaned.find(({ definition }) => definition.key === key);
    if (!change) return process.env[key];
    return change.value ?? (fromPanel.has(key) ? envValues.get(key) : process.env[key]);
  };
  const googleStaysOn =
    /^(1|true)$/i.test(String(after('GOOGLE_AUTH_ENABLED') ?? '').trim()) &&
    Boolean(after('GOOGLE_CLIENT_ID')?.trim()) &&
    Boolean(after('GOOGLE_CLIENT_SECRET')?.trim());
  const touchesGoogle = cleaned.some(({ definition }) => definition.key.startsWith('GOOGLE_'));
  if (touchesGoogle && env.googleAuthEnabled && !googleStaysOn) {
    throw new HttpError(
      'Google sign-in is the only way administrators sign in, so it cannot be switched off or left without a client ID and secret.',
      409,
    );
  }
  if (
    googleStaysOn &&
    (after('GOOGLE_CLIENT_ID') !== process.env.GOOGLE_CLIENT_ID ||
      after('GOOGLE_CLIENT_SECRET') !== process.env.GOOGLE_CLIENT_SECRET)
  ) {
    await assertGoogleClient(
      after('GOOGLE_CLIENT_ID').trim(),
      after('GOOGLE_CLIENT_SECRET').trim(),
    );
  }
  for (const { definition, value } of cleaned) {
    const key = definition.key;
    if (value === null) {
      await PlatformSetting.deleteOne({ _id: key });
    } else if (definition.type === 'secret') {
      await PlatformSetting.updateOne(
        { _id: key },
        {
          $set: {
            value: null,
            secret: encryptSecret(value),
            hint: lastFour(value),
            updatedBy: actor.id,
          },
        },
        { upsert: true },
      );
    } else {
      await PlatformSetting.updateOne(
        { _id: key },
        { $set: { value, secret: {}, hint: null, updatedBy: actor.id } },
        { upsert: true },
      );
    }
    await AdminAuditLog.create({
      actorId: actor.id,
      actorEmail: actor.email,
      action: value === null ? 'setting.clear' : 'setting.update',
      target: key,
      details: definition.type === 'secret' || value === null ? null : { value },
    });
    setEnv(key, value);
  }
  return describePlatformSettings();
}
