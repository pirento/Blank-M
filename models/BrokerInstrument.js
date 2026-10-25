/**
 * Each broker's own instrument master (exchange + symbol → the broker's token), cached for the
 * broker adapters and refreshed in bulk at most once a day per broker (services/broker/instruments.js).
 */
import mongoose from 'mongoose';
import { BROKER_PROVIDERS } from '../shared/broker-portfolio.js';

const brokerInstrumentSchema = new mongoose.Schema({
  _id: String, // `<provider>:<exchange>:<symbol>`
  provider: { type: String, enum: BROKER_PROVIDERS, required: true },
  exchange: { type: String, required: true },
  symbol: { type: String, required: true },
  token: { type: String, required: true },
  isin: { type: String, default: null },
  lotSize: { type: Number, default: null },
  tickSize: { type: Number, default: null },
  /** When the refresh that last wrote this row started; older rows are dropped after a refresh. */
  updatedAt: { type: Date, required: true },
});
brokerInstrumentSchema.index({ provider: 1, token: 1 });
// The cache age (oldest row) and removing rows a refresh no longer lists.
brokerInstrumentSchema.index({ provider: 1, updatedAt: 1 });

export const BrokerInstrument =
  mongoose.models.BrokerInstrument || mongoose.model('BrokerInstrument', brokerInstrumentSchema);
