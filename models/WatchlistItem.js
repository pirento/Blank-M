/**
 * An instrument on the member's watchlist.
 */
import mongoose from 'mongoose';
import { uuidId } from './helpers.js';
import { TRADE_SYMBOL_RE } from './Trade.js';

const watchlistItemSchema = new mongoose.Schema({
  _id: uuidId,
  userId: { type: String, required: true },
  symbol: { type: String, required: true, match: TRADE_SYMBOL_RE },
  addedAt: { type: Date, default: Date.now },
});
watchlistItemSchema.index({ userId: 1, symbol: 1 }, { unique: true });
watchlistItemSchema.index({ userId: 1, addedAt: 1, _id: 1 });

export const WatchlistItem =
  mongoose.models.WatchlistItem || mongoose.model('WatchlistItem', watchlistItemSchema);
