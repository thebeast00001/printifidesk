/**
 * Phone normalisation, kept out of the server-only WhatsApp module so it can be
 * unit-tested and reused by validation in the browser.
 */

/**
 * WhatsApp wants digits only, in full international form. A number saved as
 * "+91 98765 43210", "098765 43210" or "9876543210" all have to become
 * "919876543210" or the send is rejected with a confusing error.
 */
export function normalisePhone(raw: string, defaultCountry: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  // A single leading zero is a domestic trunk prefix, not part of the number.
  digits = digits.replace(/^0+/, "");

  if (digits.length === 10) digits = defaultCountry + digits;
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}
