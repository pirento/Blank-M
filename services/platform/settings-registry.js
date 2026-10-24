/**
 * The settings an administrator may change in the admin panel → Integrations.
 * Each entry is an environment variable name the rest of the code already
 * reads from process.env; a value saved in the panel overrides the .env value
 * (see services/platform/settings.js), so no other code has to change.
 *
 * Deliberately NOT here (they must stay in .env on the server): MONGODB_URI,
 * SESSION_SECRET, BROKER_TOKEN_ENCRYPTION_KEY (it encrypts these very values),
 * CRON_SECRET, APP_URL, PORT, HOST, TRUST_PROXY, NODE_ENV. Server alerts in
 * deploy/health-check.sh also read .env directly.
 *
 * To add a setting: add an entry below with the env name the code reads.
 */

/** @typedef {'text'|'secret'|'boolean'|'number'|'url'|'email'} SettingType */

/**
 * @type {{ key: string, group: string, label: string, type: SettingType,
 *          help?: string, min?: number, max?: number, integer?: boolean, pattern?: RegExp }[]}
 */
export const PLATFORM_SETTINGS = [
  // AI
  {
    key: 'OPENAI_API_KEY',
    group: 'OpenAI',
    label: 'API key',
    type: 'secret',
    help: 'platform.openai.com → API keys. Needed for every AI feature.',
    pattern: /^sk-[A-Za-z0-9_-]{20,}$/,
  },
  {
    key: 'AI_REQUESTS_PER_HOUR',
    group: 'OpenAI',
    label: 'AI requests per member per hour',
    type: 'number',
    min: 1,
    max: 1000,
  },

  // Zerodha
  { key: 'KITE_API_KEY', group: 'Zerodha Kite', label: 'API key', type: 'text' },
  { key: 'KITE_API_SECRET', group: 'Zerodha Kite', label: 'API secret', type: 'secret' },
  {
    key: 'KITE_REDIRECT_URI',
    group: 'Zerodha Kite',
    label: 'Redirect URL',
    type: 'url',
    pattern: /\/api\/kite\/callback$/,
    help: 'Must match the Kite developer console exactly, e.g. https://your-domain/api/kite/callback.',
  },

  // Other brokers (platform OAuth apps)
  { key: 'UPSTOX_API_KEY', group: 'Upstox', label: 'API key', type: 'text' },
  {
    key: 'UPSTOX_API_SECRET',
    group: 'Upstox',
    label: 'API secret',
    type: 'secret',
    help: 'Redirect URL to register with Upstox: https://your-domain/api/upstox/callback.',
  },
  { key: 'FYERS_APP_ID', group: 'Fyers', label: 'App ID (e.g. ABCD1234-100)', type: 'text' },
  {
    key: 'FYERS_SECRET_ID',
    group: 'Fyers',
    label: 'Secret ID',
    type: 'secret',
    help: 'Redirect URL to register with Fyers: https://your-domain/api/fyers/callback.',
  },

  // Payments
  {
    key: 'RAZORPAY_KEY_ID',
    group: 'Razorpay payments',
    label: 'Key ID',
    type: 'text',
    pattern: /^rzp_(live|test)_[A-Za-z0-9]{8,}$/,
    help: 'Razorpay Dashboard → Account & Settings → API keys. Use rzp_test_ keys until you are ready.',
  },
  { key: 'RAZORPAY_KEY_SECRET', group: 'Razorpay payments', label: 'Key secret', type: 'secret' },
  {
    key: 'RAZORPAY_WEBHOOK_SECRET',
    group: 'Razorpay payments',
    label: 'Webhook secret',
    type: 'secret',
    help: 'Webhook URL: https://your-domain/api/billing/razorpay/webhook (subscription.* events).',
  },

  // Email
  { key: 'SMTP_HOST', group: 'Email (SMTP)', label: 'Host', type: 'text' },
  {
    key: 'SMTP_PORT',
    group: 'Email (SMTP)',
    label: 'Port',
    type: 'number',
    integer: true,
    min: 1,
    max: 65535,
  },
  {
    key: 'SMTP_SECURE',
    group: 'Email (SMTP)',
    label: 'Use TLS from the start (port 465)',
    type: 'boolean',
  },
  { key: 'SMTP_USER', group: 'Email (SMTP)', label: 'Username', type: 'text' },
  { key: 'SMTP_PASSWORD', group: 'Email (SMTP)', label: 'Password', type: 'secret' },
  {
    key: 'SMTP_FROM',
    group: 'Email (SMTP)',
    label: 'From address',
    type: 'text',
    help: 'e.g. Pirento Blank <no-reply@your-domain>',
  },

  // Telegram
  {
    key: 'TELEGRAM_BOT_TOKEN',
    group: 'Telegram bot',
    label: 'Bot token (@BotFather)',
    type: 'secret',
  },
  { key: 'TELEGRAM_BOT_USERNAME', group: 'Telegram bot', label: 'Bot username', type: 'text' },
  {
    key: 'TELEGRAM_WEBHOOK_SECRET',
    group: 'Telegram bot',
    label: 'Webhook secret (32+ characters)',
    type: 'secret',
    // Telegram allows letters, digits, _ and -; shorter secrets switch the bot off.
    pattern: /^[A-Za-z0-9_-]{32,256}$/,
    help: 'After changing the token or this secret, save and press Set webhook.',
  },

  // Google sign-in
  { key: 'GOOGLE_AUTH_ENABLED', group: 'Google sign-in', label: 'Enabled', type: 'boolean' },
  { key: 'GOOGLE_CLIENT_ID', group: 'Google sign-in', label: 'Client ID', type: 'text' },
  { key: 'GOOGLE_CLIENT_SECRET', group: 'Google sign-in', label: 'Client secret', type: 'secret' },

  // Push notifications
  {
    key: 'VAPID_PUBLIC_KEY',
    group: 'Push notifications',
    label: 'VAPID public key',
    type: 'text',
    help: 'Generate a pair with node scripts/generate-vapid-keys.js.',
  },
  {
    key: 'VAPID_PRIVATE_KEY',
    group: 'Push notifications',
    label: 'VAPID private key',
    type: 'secret',
  },
  {
    key: 'VAPID_SUBJECT',
    group: 'Push notifications',
    label: 'Contact (mailto:…)',
    type: 'text',
    pattern: /^(mailto:\S+@\S+|https:\/\/\S+)$/,
  },

  // Live market data for every member (TrueData). Needs TrueData's redistribution permission.
  {
    key: 'TRUEDATA_USER',
    group: 'Live market data (TrueData)',
    label: 'TrueData login',
    type: 'text',
    help: 'Live prices and charts for all members. Showing the data to members needs TrueData’s and the exchange’s written permission. Also start the feed: pm2 start ecosystem.config.cjs.',
  },
  {
    key: 'TRUEDATA_PASSWORD',
    group: 'Live market data (TrueData)',
    label: 'TrueData password',
    type: 'secret',
  },
  {
    key: 'TRUEDATA_PORT',
    group: 'Live market data (TrueData)',
    label: 'Real-time port (usually 8082)',
    type: 'number',
    integer: true,
    min: 1,
    max: 65535,
  },

  // Business details shown on the public Terms, Privacy, Refund and Contact pages
  // (Razorpay checks these pages before it activates live payments).
  {
    key: 'BUSINESS_NAME',
    group: 'Business details (legal pages)',
    label: 'Legal business name',
    type: 'text',
    help: 'As on your PAN/GST, e.g. "Pirento Group" or your own name for a sole proprietorship.',
  },
  {
    key: 'SUPPORT_EMAIL',
    group: 'Business details (legal pages)',
    label: 'Support email',
    type: 'email',
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  },
  {
    key: 'SUPPORT_PHONE',
    group: 'Business details (legal pages)',
    label: 'Support phone',
    type: 'text',
  },
  {
    key: 'BUSINESS_ADDRESS',
    group: 'Business details (legal pages)',
    label: 'Registered address (one line)',
    type: 'text',
  },
  {
    key: 'GRIEVANCE_OFFICER',
    group: 'Business details (legal pages)',
    label: 'Grievance officer name',
    type: 'text',
    help: 'Named on the Privacy page, as Indian IT rules expect.',
  },

  // Live orders
  {
    key: 'LIVE_TRADING_ENABLED',
    group: 'Live orders (Zerodha)',
    label: 'Allow live orders on this server',
    type: 'boolean',
    help: 'Members still have to turn it on themselves and verify an authenticator.',
  },
  {
    key: 'LIVE_ORDER_MAX_VALUE',
    group: 'Live orders (Zerodha)',
    label: 'Maximum order value (₹)',
    type: 'number',
    min: 1,
    max: 1e9,
  },
  {
    key: 'LIVE_ORDER_MAX_QUANTITY',
    group: 'Live orders (Zerodha)',
    label: 'Maximum quantity per order',
    type: 'number',
    min: 1,
    max: 1e6,
  },
  {
    key: 'LIVE_ORDER_DAILY_LIMIT',
    group: 'Live orders (Zerodha)',
    label: 'Orders per member per day',
    type: 'number',
    min: 1,
    max: 1000,
  },
  {
    key: 'LIVE_ORDER_MAX_PRICE_DEVIATION_PERCENT',
    group: 'Live orders (Zerodha)',
    label: 'Maximum distance from the current price (%)',
    type: 'number',
    min: 0.1,
    max: 50,
  },
];

/** Registry entry by key, or undefined for keys the panel may not change. */
export const settingDefinition = (key) => PLATFORM_SETTINGS.find((entry) => entry.key === key);
