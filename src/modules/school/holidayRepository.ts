// school_holidays SQL (contract §8: the holiday calendar suppresses trip generation and false
// "trip not started" alerts). end_date is an inclusive calendar day. Rows are hard-deleted (the
// audit log keeps the old values); RLS limits everything to the current school.
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';

const SCHOOL = "nullif(current_setting('app.school_id', true), '')::uuid";

export interface HolidayRow extends Record<string, unknown> {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  applies_to: 'all' | 'morning' | 'afternoon';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface HolidayFilter {
  from?: string;
  to?: string;
  appliesTo?: string;
  q?: string;
}

const COLUMNS = 'h.id, h.name, h.start_date, h.end_date, h.applies_to, h.created_by, h.created_at, h.updated_at';

function where(f: HolidayFilter) {
  return {
    sql: `($1::date is null or h.end_date >= $1::date)
      and ($2::date is null or h.start_date <= $2::date)
      and ($3::text is null or h.applies_to = $3)
      and ($4::text is null or h.name ilike '%' || $4 || '%')`,
    params: [f.from ?? null, f.to ?? null, f.appliesTo ?? null, f.q ? escapeLike(f.q) : null],
  };
}

export function page(tx: Tx, f: HolidayFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<HolidayRow>(tx, { select: COLUMNS, from: 'from school_holidays h', where: w.sql, params: w.params, ...o });
}

export function exportRows(tx: Tx, f: HolidayFilter, orderBy: string): Promise<HolidayRow[]> {
  const w = where(f);
  return tx.many<HolidayRow>(`select ${COLUMNS} from school_holidays h where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

export function find(tx: Tx, id: string, { lock = false } = {}): Promise<HolidayRow | null> {
  return tx.maybeOne<HolidayRow>(`select ${COLUMNS} from school_holidays h where h.id = $1${lock ? ' for update' : ''}`, [id]);
}

/** Serialises holiday writes of one school (duplicate check + write), transaction-scoped. */
export async function lockCalendar(tx: Tx): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('school_holidays:' || ${SCHOOL}::text, 0))`);
}

/** Another holiday with the same name (case-insensitive) starting the same day. */
export async function duplicateExists(tx: Tx, name: string, startDate: string, exceptId: string | null = null): Promise<boolean> {
  const row = await tx.maybeOne(
    'select 1 from school_holidays where lower(name) = lower($1) and start_date = $2::date and ($3::uuid is null or id <> $3::uuid)',
    [name, startDate, exceptId],
  );
  return row !== null;
}

export function insert(tx: Tx, h: { name: string; startDate: string; endDate: string; appliesTo: string }): Promise<HolidayRow> {
  return tx.one<HolidayRow>(
    `insert into school_holidays (school_id, name, start_date, end_date, applies_to, created_by)
     values (${SCHOOL}, $1, $2, $3, $4, $5)
     returning id, name, start_date, end_date, applies_to, created_by, created_at, updated_at`,
    [h.name, h.startDate, h.endDate, h.appliesTo, tx.ctx.actorId],
  );
}

export function update(tx: Tx, id: string, h: { name: string; startDate: string; endDate: string; appliesTo: string }): Promise<HolidayRow> {
  return tx.one<HolidayRow>(
    `update school_holidays set name = $2, start_date = $3, end_date = $4, applies_to = $5, updated_at = now()
      where id = $1
      returning id, name, start_date, end_date, applies_to, created_by, created_at, updated_at`,
    [id, h.name, h.startDate, h.endDate, h.appliesTo],
  );
}

export async function remove(tx: Tx, id: string): Promise<boolean> {
  return ((await tx.query('delete from school_holidays where id = $1', [id])).rowCount ?? 0) > 0;
}

/**
 * Holidays covering `localDate` for a direction (null = any direction / non-school trips): rows
 * with applies_to 'all' or that direction. Used by trip generation and "not started" checks.
 */
export function coveringHolidays(tx: Tx, localDate: string, direction: 'morning' | 'afternoon' | null): Promise<HolidayRow[]> {
  return tx.many<HolidayRow>(
    `select ${COLUMNS} from school_holidays h
      where h.start_date <= $1::date and h.end_date >= $1::date
        and (h.applies_to = 'all' or $2::text is null or h.applies_to = $2)
      order by h.start_date, h.id`,
    [localDate, direction],
  );
}
