// Phone numbers (contract §6: parent identity is the E.164 mobile number).
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';

export const DEFAULT_COUNTRY: CountryCode = 'IN';

/** Any reasonable spelling ('98450 12345', '+91 98450-12345', '09845012345') → E.164, or null. */
export function normalizePhone(raw: unknown, defaultCountry: CountryCode = DEFAULT_COUNTRY): string | null {
  if (typeof raw !== 'string' || raw.trim().length < 6 || raw.length > 32) return null;
  const parsed = parsePhoneNumberFromString(raw.trim(), defaultCountry);
  if (!parsed?.isValid()) return null;
  return parsed.number;
}

/** Masked form for logs/UI: +91******2345. */
export function maskPhone(e164: string): string {
  if (e164.length <= 6) return '***';
  return `${e164.slice(0, 3)}${'*'.repeat(Math.max(0, e164.length - 7))}${e164.slice(-4)}`;
}

/** Zod: phone input → E.164 string. */
export const phoneE164 = (defaultCountry: CountryCode = DEFAULT_COUNTRY) =>
  z.string().transform((v, ctx) => {
    const n = normalizePhone(v, defaultCountry);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a valid mobile number' });
      return z.NEVER;
    }
    return n;
  });
