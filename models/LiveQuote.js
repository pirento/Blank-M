/**
 * Live market data shared between processes: the feed process (scripts/market-feed.js) writes the
 * latest price of each symbol members are watching, and web processes register which symbols they
 * want. Both are tiny and short-lived.
 */
import mongoose from 'mongoose';

const liveQuoteSchema = new mongoose.Schema(
  {
    _id: String, // our symbol, e.g. RELIANCE or NIFTY
    price: { type: Number, required: true },
    /** When the exchange traded at this price. */
    at: { type: Date, required: true },
  },
  { versionKey: false },
);
// A symbol nobody watches stops updating; drop it after a day.
liveQuoteSchema.index({ at: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

const liveSubscriptionSchema = new mongoose.Schema(
  {
    _id: String, // symbol
    /** Renewed by web processes while a page shows the symbol; the feed drops it after this. */
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);
liveSubscriptionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LiveQuote = mongoose.models.LiveQuote || mongoose.model('LiveQuote', liveQuoteSchema);
export const LiveSubscription =
  mongoose.models.LiveSubscription || mongoose.model('LiveSubscription', liveSubscriptionSchema);
