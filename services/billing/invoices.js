/**
 * GST invoices for Premium payments (CGST Rules 2017, rule 46): one per captured Razorpay payment,
 * issued when the webhook records the payment (subscriptions.js). If that fails the payment still
 * counts, and the invoice is issued the next time the member's or the administrator's payment list
 * is opened. Without a seller GSTIN the document is a payment receipt with no tax lines.
 */
import { AccountSettings, Invoice, Payment, User, nextSequence } from '../../models/index.js';
import { gstState, gstinProblem } from '../../shared/gst.js';
import { toIst } from '../../shared/market.js';
import { financialYearOf } from '../../shared/tax-report.js';
import { HttpError } from '../errors.js';
import { createLogger, errorName } from '../logger.js';
import { loadBusiness } from './business.js';
import { loadPlan } from './plan.js';

const log = createLogger('invoices');

/**
 * Invoice amounts in rupees (two decimals) for `amount` at `rate`% GST, worked in whole paise so
 * CGST + SGST is exactly the tax. `inclusive`: the amount already includes GST; otherwise GST is
 * added on top. `interState`: IGST instead of CGST + SGST.
 */
export function invoiceAmounts({ amount, rate, inclusive, interState }) {
  const paid = Math.round(amount * 100);
  const taxable = inclusive ? Math.round((paid * 100) / (100 + rate)) : paid;
  const tax = inclusive ? paid - taxable : Math.round((taxable * rate) / 100);
  const sgst = interState ? 0 : Math.floor(tax / 2);
  return {
    taxableValue: taxable / 100,
    cgst: interState ? 0 : (tax - sgst) / 100,
    sgst: sgst / 100,
    igst: interState ? tax / 100 : 0,
    total: (taxable + tax) / 100,
  };
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}`.trim();
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} Hundred ${words(n % 100)}`.trim();
  // Indian grouping: 1,00,00,000 is a crore and 1,00,000 a lakh.
  const [size, name] = n >= 1e7 ? [1e7, 'Crore'] : n >= 1e5 ? [1e5, 'Lakh'] : [1e3, 'Thousand'];
  return `${words(Math.floor(n / size))} ${name} ${words(n % size)}`.trim();
}

/** e.g. 120000.5 → "Rupees One Lakh Twenty Thousand and Fifty Paise Only". */
export function amountInWords(amount) {
  const paise = Math.round(amount * 100);
  const rupees = words(Math.floor(paise / 100)) || 'Zero';
  return `Rupees ${rupees}${paise % 100 ? ` and ${words(paise % 100)} Paise` : ''} Only`;
}

/**
 * The invoice of a payment, issued once if the captured payment needs one (`invoiceDue`); null
 * when it needs none. Seller and buyer details are copied in as they are now.
 */
export async function issueInvoice(paymentId) {
  const existing = await Invoice.findOne({ paymentId }).lean();
  if (existing) return existing;
  const payment = await Payment.findById(paymentId).lean();
  if (!payment?.invoiceDue || !payment.userId) return null;
  const [seller, plan, user, settings] = await Promise.all([
    loadBusiness(),
    loadPlan(),
    User.findById(payment.userId, { email: 1, displayName: 1 }).lean(),
    AccountSettings.findById(payment.userId, { billingDetails: 1 }).lean(),
  ]);
  const buyer = settings?.billingDetails ?? {};
  const taxed = Boolean(seller.gstin);
  const sellerState = gstState(seller.state);
  const buyerState = gstState(buyer.state);
  const amounts = taxed
    ? invoiceAmounts({
        amount: payment.amount,
        rate: seller.rate,
        inclusive: seller.pricesIncludeGst,
        interState: Boolean(buyerState) && buyerState.code !== seller.state,
      })
    : { taxableValue: payment.amount, total: payment.amount };
  const issuedAt = new Date();
  const financialYear = financialYearOf(toIst(issuedAt).date);
  const sequence = await nextSequence(`invoice:${financialYear}`);
  const number = `${seller.invoicePrefix}/${financialYear.slice(2)}/${String(sequence).padStart(5, '0')}`;
  // Rule 46 allows 16 characters: a 4-character prefix leaves room for 99,999 invoices a year.
  if (number.length > 16) throw new Error('Invoice number longer than 16 characters.');
  try {
    const invoice = await Invoice.create({
      number,
      paymentId,
      userId: payment.userId,
      issuedAt,
      financialYear,
      type: taxed ? 'tax-invoice' : 'receipt',
      seller: {
        legalName: seller.legalName,
        tradeName: seller.tradeName,
        address: seller.address,
        state: sellerState,
        gstin: seller.gstin,
        supportEmail: seller.supportEmail,
      },
      buyer: {
        name: buyer.name || user?.displayName || user?.email || '',
        email: user?.email ?? '',
        address: buyer.address ?? '',
        state: buyerState,
        gstin: buyer.gstin ?? '',
      },
      description: `${plan.name} — 1 month`,
      sac: seller.sac,
      rate: taxed ? seller.rate : 0,
      ...amounts,
      // The buyer's state, or the seller's when the buyer gave none.
      placeOfSupply: buyerState ?? sellerState,
    });
    return invoice.toObject();
  } catch (error) {
    // shortcut: a webhook racing a page view for the same payment burns one number (a gap in the
    // series); claim the payment before taking a number if gaps ever matter.
    const winner = error?.code === 11000 ? await Invoice.findOne({ paymentId }).lean() : null;
    if (winner) return winner;
    throw error;
  }
}

/**
 * Invoice numbers by payment id for these Payment rows, issuing any that are due but missing (the
 * webhook could not issue them). A failure is logged and the payment shows without an invoice.
 */
export async function invoiceNumbers(rows) {
  const numbers = new Map(
    (
      await Invoice.find(
        { paymentId: { $in: rows.map((row) => row._id) } },
        { number: 1, paymentId: 1 },
      ).lean()
    ).map((invoice) => [invoice.paymentId, invoice.number]),
  );
  for (const row of rows) {
    if (!row.invoiceDue || numbers.has(row._id)) continue;
    const invoice = await issueInvoice(row._id).catch((error) => {
      log.error('invoice not issued', { paymentId: row._id, error: errorName(error) });
      return null;
    });
    if (invoice) numbers.set(row._id, invoice.number);
  }
  return numbers;
}

/** The member's details for future invoices (Billing page). */
export async function loadBillingDetails(userId) {
  const row = await AccountSettings.findById(userId, { billingDetails: 1 }).lean();
  return { name: '', state: '', gstin: '', address: '', ...row?.billingDetails };
}

/**
 * Checks and saves the member's invoice details (strings already trimmed and length-checked by the
 * controller). They apply to invoices issued from now on.
 */
export async function saveBillingDetails(userId, details) {
  const next = { ...details, gstin: details.gstin.toUpperCase() };
  if (next.state && !gstState(next.state)) {
    throw new HttpError('Choose the state from the list.', 400);
  }
  if (next.gstin) {
    const problem = gstinProblem(next.gstin, next.state);
    if (problem) throw new HttpError(problem, 400);
    // Rule 46: a registered buyer's invoice carries their name and address.
    if (!next.name || !next.address) {
      throw new HttpError('Add the business name and address that go with the GSTIN.', 400);
    }
  }
  await AccountSettings.updateOne(
    { _id: userId },
    { $set: { billingDetails: next } },
    { upsert: true },
  );
  return next;
}

/** The invoice with this number if `user` may see it (its member or an administrator), else null. */
export async function invoiceFor(number, user) {
  const invoice = await Invoice.findOne({ number }).lean();
  return invoice && (invoice.userId === user._id || user.role === 'admin') ? invoice : null;
}
