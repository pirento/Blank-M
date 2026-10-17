/** Zerodha instrument master (NSE equities), refreshed from the public CSV. */
import mongoose from 'mongoose';

const instrumentSchema = new mongoose.Schema(
  {
    _id: String, // instrument_key
    instrumentToken: { type: Number, unique: true, sparse: true },
    exchangeToken: { type: Number, default: null },
    exchange: { type: String, required: true },
    segment: { type: String, default: null },
    tradingSymbol: { type: String, required: true },
    name: { type: String, default: null },
    isin: { type: String, default: null },
    instrumentType: { type: String, default: null },
    expiry: { type: String, default: null },
    strike: { type: Number, default: null },
    lotSize: { type: Number, default: null },
    tickSize: { type: Number, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' } },
);
instrumentSchema.index({ exchange: 1, tradingSymbol: 1 });

export const Instrument =
  mongoose.models.Instrument || mongoose.model('Instrument', instrumentSchema);
