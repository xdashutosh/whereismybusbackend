// Pagination & sorting (contract §5): page ≥ 1 (default 1), limit 1–100 (default 20),
// sort=field | -field (comma separated, whitelisted per endpoint → trusted ORDER BY), meta
// { page, limit, total, totalPages }. One query per list endpoint (contract §3): pagedQuery()
// returns the page and the total in ONE round trip.
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type ListMeta } from '@wimb/shared';
import type { Tx } from '../db/tenant.js';
import { validationError } from './errors.js';

export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT };
export const MAX_PAGE = 100000;
/** Hard cap for CSV/PDF exports of a list. */
export const MAX_EXPORT_ROWS = 10000;

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export interface Pagination {
  page: number;
  limit: number;
  offset: number;
}

/** { page?, limit? } (numbers or strings) → { page, limit, offset }; invalid → VALIDATION_ERROR. */
export function parsePagination(
  input: { page?: unknown; limit?: unknown } = {},
  { defaultLimit = DEFAULT_PAGE_LIMIT, maxLimit = MAX_PAGE_LIMIT } = {},
): Pagination {
  const details: { path: string; message: string }[] = [];
  const read = (name: 'page' | 'limit', def: number, max: number): number => {
    const raw = emptyToUndefined(input[name]);
    if (raw === undefined || raw === null) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      details.push({ path: name, message: `Must be an integer between 1 and ${max}` });
      return def;
    }
    return n;
  };
  const page = read('page', 1, MAX_PAGE);
  const limit = read('limit', defaultLimit, maxLimit);
  if (details.length) throw validationError('Invalid pagination parameters.', details);
  return { page, limit, offset: (page - 1) * limit };
}

export interface SortSpec {
  /** apiField → trusted SQL expression. */
  allowed: Readonly<Record<string, string>>;
  /** Used when `sort` is empty, e.g. '-createdAt'. */
  defaultSort?: string;
  /** Trusted expression appended for a stable order (e.g. 'b.id'). */
  tiebreaker?: string;
  maxFields?: number;
}

const FIELD_RE = /^-?[A-Za-z][A-Za-z0-9]*$/;

/** Whitelisted sort → { orderBy: 'ORDER BY …', fields }. Client text never reaches SQL. */
export function parseSort(sort: string | undefined | null, { allowed, defaultSort, tiebreaker, maxFields = 3 }: SortSpec) {
  const raw = ((typeof sort === 'string' ? sort.trim() : '') || defaultSort || '').trim();
  const parts = raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const allowedList = Object.keys(allowed).join(', ');
  const fail = (message: string) => validationError(message, [{ path: 'sort', message }]);
  if (parts.length > maxFields) throw fail(`At most ${maxFields} sort fields are allowed`);
  const fields: { field: string; direction: 'ASC' | 'DESC'; expr: string }[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (!FIELD_RE.test(part)) throw fail(`Unsupported sort field "${part}". Allowed: ${allowedList}`);
    const desc = part.startsWith('-');
    const field = desc ? part.slice(1) : part;
    if (!Object.hasOwn(allowed, field)) throw fail(`Unsupported sort field "${field}". Allowed: ${allowedList}`);
    if (seen.has(field)) continue;
    seen.add(field);
    fields.push({ field, direction: desc ? 'DESC' : 'ASC', expr: allowed[field]! });
  }
  const clauses = fields.map((f) => `${f.expr} ${f.direction} NULLS LAST`);
  if (tiebreaker) clauses.push(`${tiebreaker} ASC`);
  return {
    orderBy: clauses.length ? `ORDER BY ${clauses.join(', ')}` : '',
    fields: fields.map(({ field, direction }) => ({ field, direction })),
  };
}

export function listMeta({ page, limit, total }: { page: number; limit: number; total: number }): ListMeta {
  const t = Math.max(0, Number(total) || 0);
  return { page, limit, total: t, totalPages: t === 0 ? 0 : Math.ceil(t / limit) };
}

const PAGE_TOTAL = 'wimb_page_total';
const MATCH_TOTAL = 'wimb_match_total';

export interface PagedQuerySpec {
  /** Trusted column list of the page rows (joins/sub-selects for display names). */
  select: string;
  /** Trusted `from … join …` clause. */
  from: string;
  /** Trusted predicate over $1…$n of params (default 'true'). */
  where?: string;
  params?: readonly unknown[];
  /** ORDER BY clause from parseSort(). */
  orderBy?: string;
  limit: number;
  offset: number;
}

/**
 * One-round-trip paged list: a lateral page carrying count(*) over() plus a lazily evaluated
 * fallback count for pages past the end, so `total` is always the real number of matches.
 */
export function buildPagedQuery({ select, from, where = 'true', params = [], orderBy = '', limit, offset }: PagedQuerySpec) {
  if (!select || !from) throw new TypeError('buildPagedQuery requires select and from');
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) {
    throw new TypeError('buildPagedQuery requires an integer limit ≥ 1 and offset ≥ 0');
  }
  const n = params.length;
  const text = `select p.*, coalesce(p.${PAGE_TOTAL}, (select count(*) ${from} where ${where})) as ${MATCH_TOTAL}
  from (select 1) wimb_one
  left join lateral (
    select ${select}, count(*) over () as ${PAGE_TOTAL}
      ${from}
     where ${where}
     ${orderBy}
     limit $${n + 1} offset $${n + 2}
  ) p on true`;
  return { text, values: [...params, limit, offset] };
}

/** Rows of buildPagedQuery() → { rows (total columns stripped), total }. */
export function splitPagedRows<R extends Record<string, unknown>>(rows: R[]): { rows: Omit<R, typeof PAGE_TOTAL | typeof MATCH_TOTAL>[]; total: number } {
  const first = rows[0];
  if (!first) return { rows: [], total: 0 };
  const total = Number(first[MATCH_TOTAL]) || 0;
  if (rows.length === 1 && first[PAGE_TOTAL] === null) return { rows: [], total };
  return {
    rows: rows.map((r) => {
      const { [PAGE_TOTAL]: _p, [MATCH_TOTAL]: _m, ...rest } = r;
      return rest;
    }),
    total,
  };
}

/** Runs a paged list inside a tenant transaction → { rows (snake_case), total }. */
export async function pagedQuery<R extends Record<string, unknown> = Record<string, unknown>>(tx: Tx, spec: PagedQuerySpec) {
  const { text, values } = buildPagedQuery(spec);
  return splitPagedRows<R>(await tx.many<R>(text, values));
}

/** Escapes LIKE/ILIKE wildcards: `ilike '%' || $1 || '%'` with escapeLike(q). */
export function escapeLike(value: string): string {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}
