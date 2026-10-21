// Reusable Zod primitives shared by the backend validators and the web forms.
import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

function isRealDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Lower-cased UUID. */
export const uuid = () =>
  z
    .string()
    .trim()
    .regex(UUID_RE, 'Must be a valid UUID')
    .transform((s) => s.toLowerCase());

/** 'YYYY-MM-DD' calendar date (no timezone). */
export const isoDate = () =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format')
    .refine(isRealDate, 'Must be a valid calendar date');

/** 'HH:mm' (accepts 'HH:mm:ss', normalised to 'HH:mm'). */
export const hhmm = () =>
  z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Must be a time in HH:mm format')
    .transform((s) => s.slice(0, 5));

/** ISO-8601 instant with offset, kept as a string. */
export const isoDateTime = () => z.string().trim().datetime({ offset: true, message: 'Must be an ISO-8601 timestamp' });

export const latitude = () => z.number({ invalid_type_error: 'Must be a number' }).finite().min(-90).max(90);
export const longitude = () => z.number({ invalid_type_error: 'Must be a number' }).finite().min(-180).max(180);

/** Required trimmed text. */
export const text = (max = 200, min = 1) =>
  z
    .string()
    .trim()
    .min(min, min === 1 ? 'Required' : `Must be at least ${min} characters`)
    .max(max);

/** Optional text: '' / null → null. */
export const optionalText = (max = 500) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max).nullable().optional());

/** Lower-cased e-mail address. */
export const email = () =>
  z
    .string()
    .trim()
    .max(254)
    .email('Must be a valid e-mail address')
    .transform((s) => s.toLowerCase());

/** IANA time zone name. */
export const timeZone = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Must be a valid IANA time zone');

/** Semantic version 'MAJOR.MINOR.PATCH' (pre-release/build suffix allowed). */
export const semver = () =>
  z
    .string()
    .trim()
    .regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/, 'Must be a version like 1.2.3');

// ── query-string helpers (values arrive as strings) ──────────────────────────
export const queryString = (max = 100) => z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());
export const queryInt = (min: number, max: number) => z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).optional());
export const queryBool = () =>
  z.preprocess(
    (v) => {
      const s = emptyToUndefined(v);
      if (s === undefined || typeof s === 'boolean') return s;
      const t = String(s).toLowerCase();
      if (t === 'true' || t === '1') return true;
      if (t === 'false' || t === '0') return false;
      return s;
    },
    z.boolean({ invalid_type_error: 'Must be true or false' }).optional(),
  );
export const queryEnumList = <T extends [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => {
      const s = emptyToUndefined(v);
      if (s === undefined) return undefined;
      const arr = Array.isArray(s) ? s : String(s).split(',');
      return arr.map((x) => String(x).trim()).filter(Boolean);
    },
    z.array(z.enum(values)).min(1).optional(),
  );

// ── date-range filter `period=<from>..<to>` ──────────────────────────────────
/**
 * `period` query value: `YYYY-MM-DD..YYYY-MM-DD` (either side may be empty: `2026-10-01..`), or one
 * `YYYY-MM-DD` day. Same format as the web filters and the dashboard quick links.
 */
export const PERIOD_RE = /^(?:(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?|(\d{4}-\d{2}-\d{2}))$/;

/** Shape fragment: the `period` key itself (only invalid values remain after withPeriod expands it). */
export const periodShape = {
  period: z.preprocess(emptyToUndefined, z.string().trim().max(30).regex(PERIOD_RE, 'Must be a date range like 2026-10-01..2026-10-31').optional()),
};

/**
 * Accepts `period=<from>..<to>` on a list/report query next to the older `from` / `to`: a valid period
 * fills `from` / `to` that were not given (explicit `from` / `to` win) and is removed; an invalid one
 * stays for periodShape to reject. Wrap the query object schema (with periodShape spread into it).
 */
export function withPeriod<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const { period, ...rest } = raw as Record<string, unknown>;
    const value = emptyToUndefined(period);
    if (value === undefined) return rest;
    const m = typeof value === 'string' ? PERIOD_RE.exec(value.trim()) : null;
    if (!m) return raw;
    const from = m[3] ?? m[1];
    const to = m[3] ?? m[2];
    const out: Record<string, unknown> = { ...rest };
    if (from && emptyToUndefined(out.from) === undefined) out.from = from;
    if (to && emptyToUndefined(out.to) === undefined) out.to = to;
    return out;
  }, schema);
}

// ── pagination (contract §5) ─────────────────────────────────────────────────
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/** Shape fragment for list query schemas: page ≥ 1, limit 1–100, sort, q, format. */
export const listQueryShape = {
  page: queryInt(1, 100000),
  limit: queryInt(1, MAX_PAGE_LIMIT),
  sort: queryString(200),
  q: queryString(100),
};

export const listQuery = z.object(listQueryShape);
export type ListQuery = z.infer<typeof listQuery>;

/** `?format=` on admin lists (csv) and reports (csv | pdf). */
export const exportFormat = z.preprocess(emptyToUndefined, z.enum(['json', 'csv', 'pdf']).optional());

export const idParams = z.object({ id: uuid() });
