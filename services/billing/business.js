/**
 * The seller details printed on GST invoices, set in the admin panel → Plans & billing → Invoice
 * details and stored as one PlatformSetting document ("billing.business"). Issued invoices keep a
 * snapshot, so a change here applies to future invoices only.
 */
import { PlatformSetting } from '../../models/index.js';
import { gstState, gstinProblem } from '../../shared/gst.js';
import { recordAdminAction } from '../admin/audit.js';
import { HttpError } from '../errors.js';

const BUSINESS_KEY = 'billing.business';

/** The seller details with defaults; unsaved name, address and email come from the legal pages. */
export async function loadBusiness() {
  const row = await PlatformSetting.findById(BUSINESS_KEY).lean();
  return {
    legalName: process.env.BUSINESS_NAME?.trim() || '',
    tradeName: '',
    address: process.env.BUSINESS_ADDRESS?.trim() || '',
    state: '',
    gstin: '',
    sac: '',
    rate: 18,
    invoicePrefix: 'PB',
    supportEmail: process.env.SUPPORT_EMAIL?.trim() || '',
    ...(row?.value && typeof row.value === 'object' ? row.value : {}),
  };
}

/**
 * Checks and saves the administrator's invoice details (every field, strings already trimmed and
 * length-checked by the controller); returns them. Audited.
 */
export async function saveBusiness(admin, details) {
  const next = {
    ...details,
    gstin: details.gstin.toUpperCase(),
    invoicePrefix: details.invoicePrefix.toUpperCase(),
  };
  if (!next.legalName || !next.address) {
    throw new HttpError('Fill in the legal name and the full address.', 400);
  }
  if (!gstState(next.state)) throw new HttpError('Choose the state from the list.', 400);
  const problem = next.gstin && gstinProblem(next.gstin, next.state);
  if (problem) throw new HttpError(problem, 400);
  // At most two decimals (e.g. 0.25); the highest GST slab is 40%.
  if (
    next.rate < 0 ||
    next.rate > 40 ||
    Math.abs(next.rate * 100 - Math.round(next.rate * 100)) > 1e-9
  ) {
    throw new HttpError('GST rate must be a percentage from 0 to 40 (e.g. 18).', 400);
  }
  // "PREF/26-27/00001" stays within the 16 characters rule 46 allows.
  if (!/^[A-Z0-9]{1,4}$/.test(next.invoicePrefix)) {
    throw new HttpError('Invoice prefix must be 1–4 letters or digits.', 400);
  }
  if (next.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.supportEmail)) {
    throw new HttpError('Enter a valid support email.', 400);
  }
  await PlatformSetting.updateOne(
    { _id: BUSINESS_KEY },
    { $set: { value: next, updatedBy: admin.user.id } },
    { upsert: true },
  );
  await recordAdminAction(admin, 'billing.business', BUSINESS_KEY, next);
  return next;
}
