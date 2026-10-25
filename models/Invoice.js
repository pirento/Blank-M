/**
 * GST tax invoices (or payment receipts while the seller has no GSTIN), one per captured Razorpay
 * payment (services/billing/invoices.js). Seller and buyer are snapshots taken when the invoice was
 * issued, so later setting changes never alter an issued invoice. A financial record: kept, never
 * expired, kept when the member is deleted.
 */
import mongoose from 'mongoose';

const invoiceSchema = new mongoose.Schema(
  {
    /** e.g. "PB/26-27/00001": consecutive per financial year, at most 16 characters (rule 46). */
    number: { type: String, required: true },
    paymentId: { type: String, required: true },
    userId: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    /** Indian financial year (April–March, IST), e.g. "2026-27". */
    financialYear: { type: String, required: true },
    type: { type: String, enum: ['tax-invoice', 'receipt'], required: true },
    /** { legalName, tradeName, address, state: { code, name }, gstin, supportEmail } */
    seller: { type: mongoose.Schema.Types.Mixed, required: true },
    /** { name, email, address, state: { code, name } | null, gstin } */
    buyer: { type: mongoose.Schema.Types.Mixed, required: true },
    description: { type: String, required: true },
    sac: { type: String, default: '' },
    /** GST rate in percent (0 on a receipt). Amounts are rupees with two decimals. */
    rate: { type: Number, required: true },
    taxableValue: { type: Number, required: true },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    total: { type: Number, required: true },
    /** { code, name } of the state of supply, or null when neither side has a state. */
    placeOfSupply: { type: mongoose.Schema.Types.Mixed, default: null },
    currency: { type: String, default: 'INR' },
  },
  { timestamps: true, minimize: false },
);
invoiceSchema.index({ number: 1 }, { unique: true });
// One invoice per payment, even when the webhook repeats.
invoiceSchema.index({ paymentId: 1 }, { unique: true });
invoiceSchema.index({ userId: 1, issuedAt: -1 });

export const Invoice = mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema);
