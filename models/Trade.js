/**
 * A completed round-trip trade in the journal, with its stored gross P&L and
 * charges.
 */
import mongoose from 'mongoose';
import { timestamps, uuidId } from './helpers.js';

// "&" is part of NSE names such as M&M and J&KBANK.
export const TRADE_SYMBOL_RE = /^[A-Z0-9][A-Z0-9.&_-]{0,24}$/;

const tradeSchema = new mongoose.Schema(
  {
    _id: uuidId,
    userId: { type: String, required: true },
    strategyId: { type: String, default: null },
    /** IST calendar date, YYYY-MM-DD. */
    tradeDate: { type: String, required: true },
    symbol: { type: String, required: true, match: TRADE_SYMBOL_RE },
    direction: { type: String, enum: ['Long', 'Short'], required: true },
    entryPrice: { type: Number, required: true, min: 0.0001 },
    exitPrice: { type: Number, required: true, min: 0.0001 },
    quantity: { type: Number, required: true, min: 1 },
    grossPnl: { type: Number, required: true },
    charges: { type: Number, default: 0, min: 0 },
    /** grossPnl - charges, settled to paise. */
    netPnl: { type: Number, required: true },
    notes: { type: String, default: '' },
    /** Review fields (see shared/trade-tags.js). */
    setupTags: { type: [String], default: [] },
    mistakeTags: { type: [String], default: [] },
    emotion: { type: String, default: '' },
    /** Rupees the trade would lose at its planned stop; used for R-multiples. */
    plannedRisk: { type: Number, default: null, min: 0 },
    /** EQ, FUT or OPT (see shared/segments.js); quantity is always in units. */
    segment: { type: String, enum: ['EQ', 'FUT', 'OPT'], default: 'EQ' },
    lotSize: { type: Number, default: null },
    /** Contract expiry, YYYY-MM-DD. */
    expiry: { type: String, default: null },
    strike: { type: Number, default: null },
    optionType: { type: String, enum: ['CE', 'PE', null], default: null },
    /** Execution details (shared/trade-execution.js): stop price, IST times HH:MM. */
    stopLoss: { type: Number, default: null, min: 0 },
    entryTime: { type: String, default: null },
    exitTime: { type: String, default: null },
    /** Partial exits; exitPrice is their weighted average. */
    exitLegs: {
      type: [{ _id: false, price: Number, quantity: Number }],
      default: [],
    },
    /** Orders per side for the per-order brokerage cap (null = one). */
    entryOrders: { type: Number, default: null },
    exitOrders: { type: Number, default: null },
    /** GridFS path of the attached chart screenshot (bucket trade-screenshots). */
    screenshotPath: { type: String, default: null },
  },
  timestamps,
);
tradeSchema.index({ userId: 1, tradeDate: -1, _id: -1 });
// Unlinks trades when their strategy is deleted, and per-strategy performance.
tradeSchema.index({ userId: 1, strategyId: 1 });

tradeSchema.pre('validate', function settleNet(next) {
  this.netPnl = Math.round((Number(this.grossPnl) - Number(this.charges)) * 100) / 100;
  next();
});

export const Trade = mongoose.models.Trade || mongoose.model('Trade', tradeSchema);
