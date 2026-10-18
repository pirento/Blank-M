/**
 * Platform-wide settings an administrator changes in the admin panel: API keys
 * and switches that would otherwise live in .env, plus the subscription plan.
 * Secret values are stored AES-256-GCM encrypted (services/crypto.js) and are
 * never sent back to the browser. One document per setting key.
 */
import mongoose from 'mongoose';

const platformSettingSchema = new mongoose.Schema(
  {
    /** The setting key, e.g. "KITE_API_KEY" (env name) or "billing.plan". */
    _id: { type: String, required: true },
    /** Plain value for non-secret settings (string, number, boolean or an object). */
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Encrypted value for secret settings; `value` stays null for these. */
    secret: {
      ciphertext: { type: String, default: null },
      iv: { type: String, default: null },
      tag: { type: String, default: null },
    },
    /** Last four characters of a secret, so the panel can show which key is set. */
    hint: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' }, minimize: false },
);

export const PlatformSetting =
  mongoose.models.PlatformSetting || mongoose.model('PlatformSetting', platformSettingSchema);
