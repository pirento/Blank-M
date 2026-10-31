/**
 * Indian GST basics shared by the server and the browser: states and union territories with their
 * two-digit GST state codes (the first two characters of a GSTIN), and GSTIN validation.
 */

/** Current GST state codes (25 and 28 are no longer used for new registrations). */
export const GST_STATES = [
  ['01', 'Jammu and Kashmir'],
  ['02', 'Himachal Pradesh'],
  ['03', 'Punjab'],
  ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'],
  ['06', 'Haryana'],
  ['07', 'Delhi'],
  ['08', 'Rajasthan'],
  ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'],
  ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'],
  ['13', 'Nagaland'],
  ['14', 'Manipur'],
  ['15', 'Mizoram'],
  ['16', 'Tripura'],
  ['17', 'Meghalaya'],
  ['18', 'Assam'],
  ['19', 'West Bengal'],
  ['20', 'Jharkhand'],
  ['21', 'Odisha'],
  ['22', 'Chhattisgarh'],
  ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['27', 'Maharashtra'],
  ['29', 'Karnataka'],
  ['30', 'Goa'],
  ['31', 'Lakshadweep'],
  ['32', 'Kerala'],
  ['33', 'Tamil Nadu'],
  ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'],
  ['38', 'Ladakh'],
].map(([code, name]) => ({ code, name }));

/** Union territories without a legislature charge UTGST instead of SGST (same amount). */
export const UTGST_STATE_CODES = new Set(['04', '26', '31', '35', '38']);

/** The state for a GST state code, or null. */
export const gstState = (code) => GST_STATES.find((state) => state.code === code) ?? null;

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The 15th character of a GSTIN computed from its first 14 (the standard mod-36 check). */
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/**
 * Why a GSTIN is not valid for the chosen state, or null when it is: state code, PAN, entity
 * number, 'Z', check character.
 */
export function gstinProblem(gstin, stateCode) {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    return 'A GSTIN is 15 characters: state code, PAN, entity number, Z and a check character.';
  }
  if (gstin.slice(0, 2) !== stateCode) {
    return 'The GSTIN starts with a different state code than the state chosen.';
  }
  if (gstinCheckChar(gstin) !== gstin[14]) {
    return 'That GSTIN has a typo (its last character does not match). Check it.';
  }
  return null;
}
