// Student SQL (BP §6.2 students). Runs in the caller's tenant transaction: RLS limits every
// statement to the current school; school_id is written from the transaction context, never input.
// "Effective" assignments are rows that have not ended by today (school-local, app_local_date()):
// the current one and any upcoming one; lists show the earliest per direction.
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';
import type { StudentListRow, StudentRow } from './dto.js';

/** jsonb of one assignment row; needs aliases sa (student_assignments), b, r, st and today.d. */
export const ASSIGNMENT_JSON = `jsonb_build_object(
    'id', sa.id, 'direction', sa.trip_direction, 'busId', sa.bus_id, 'busCode', b.code, 'busName', b.display_name,
    'routeId', sa.route_id, 'routeCode', r.code, 'routeName', r.name, 'stopId', sa.stop_id, 'stopName', st.name,
    'stopSequence', st.sequence, 'expectedTime', to_char(st.expected_time, 'HH24:MI'),
    'validFrom', sa.valid_from, 'validTo', sa.valid_to,
    'state', case when sa.valid_to is not null and sa.valid_to <= today.d then 'ended'
                  when sa.valid_from > today.d then 'upcoming' else 'current' end,
    'createdAt', sa.created_at)`;

export const ASSIGNMENT_JOINS = `join buses b on b.id = sa.bus_id
    join routes r on r.id = sa.route_id
    join stops st on st.id = sa.stop_id`;

const STUDENT_COLUMNS = `s.id, s.school_id, s.admission_no, s.full_name, s.class_name, s.section, s.roll_no, s.photo_file_id, s.notes,
  s.is_active, s.deleted_at, s.created_at, s.updated_at`;

const effective = (direction: 'morning' | 'afternoon') => `left join lateral (
    select ${ASSIGNMENT_JSON} as a
      from student_assignments sa ${ASSIGNMENT_JOINS}
     where sa.student_id = s.id and sa.trip_direction = '${direction}' and (sa.valid_to is null or sa.valid_to > today.d)
       and sa.valid_to is distinct from sa.valid_from
     order by sa.valid_from limit 1) ${direction === 'morning' ? 'am' : 'aa'} on true`;

const LIST_SELECT = `${STUDENT_COLUMNS}, f.key as photo_key, f.thumb_key as photo_thumb_key,
  par.parent_count, par.primary_parent, am.a as morning, aa.a as afternoon`;

const LIST_FROM = `from students s
  cross join (select app_local_date() as d) today
  left join files f on f.id = s.photo_file_id and f.status = 'uploaded'
  left join lateral (
    select count(*)::int as parent_count,
           (array_agg(jsonb_build_object('id', sp.id, 'fullName', sp.full_name, 'phone', pa.phone)
                      order by l.is_primary desc, l.created_at, sp.id))[1] as primary_parent
      from student_parents l
      join school_parents sp on sp.school_id = l.school_id and sp.parent_account_id = l.parent_account_id and sp.deleted_at is null
      join parent_accounts pa on pa.id = l.parent_account_id
     where l.student_id = s.id) par on true
  ${effective('morning')}
  ${effective('afternoon')}`;

export interface StudentFilter {
  q?: string;
  className?: string;
  section?: string;
  busId?: string;
  routeId?: string;
  stopId?: string;
  direction?: 'morning' | 'afternoon';
  unassigned?: boolean;
  isActive?: boolean;
  hasParents?: boolean;
}

function where(f: StudentFilter): { sql: string; params: unknown[] } {
  const q = f.q?.trim() ? escapeLike(f.q.trim()) : null;
  const target = Boolean(f.busId || f.routeId || f.stopId);
  return {
    sql: `s.deleted_at is null
      and ($1::text is null or s.full_name ilike '%' || $1 || '%' or s.admission_no ilike '%' || $1 || '%' or s.roll_no ilike $1)
      and ($2::text is null or lower(s.class_name) = lower($2))
      and ($3::text is null or lower(s.section) = lower($3))
      and ($4::boolean is null or s.is_active = $4)
      and ($5::boolean is null or (par.parent_count > 0) = $5)
      and (not $6::boolean or exists (
            select 1 from student_assignments x
             where x.student_id = s.id and (x.valid_to is null or x.valid_to > today.d) and x.valid_to is distinct from x.valid_from
               and ($7::text is null or x.trip_direction = $7)
               and ($8::uuid is null or x.bus_id = $8) and ($9::uuid is null or x.route_id = $9) and ($10::uuid is null or x.stop_id = $10)))
      and ($11::boolean is null or (case when $7::text = 'morning' then am.a is null
                                         when $7::text = 'afternoon' then aa.a is null
                                         else am.a is null or aa.a is null end) = $11)`,
    params: [
      q,
      f.className?.trim() || null,
      f.section?.trim() || null,
      f.isActive ?? null,
      f.hasParents ?? null,
      target,
      f.direction ?? null,
      f.busId ?? null,
      f.routeId ?? null,
      f.stopId ?? null,
      f.unassigned ?? null,
    ],
  };
}

export function page(tx: Tx, f: StudentFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<StudentListRow>(tx, { select: LIST_SELECT, from: LIST_FROM, where: w.sql, params: w.params, ...o });
}

export function exportRows(tx: Tx, f: StudentFilter, orderBy: string): Promise<StudentListRow[]> {
  const w = where(f);
  return tx.many<StudentListRow>(`select ${LIST_SELECT} ${LIST_FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

/** One live student with its list summaries (null when missing, deleted or in another school). */
export function findListRow(tx: Tx, id: string): Promise<StudentListRow | null> {
  return tx.maybeOne<StudentListRow>(`select ${LIST_SELECT} ${LIST_FROM} where s.id = $1 and s.deleted_at is null`, [id]);
}

/** Locks a live student for a write (serialises edits, links and assignment changes per student). */
export function lockStudent(tx: Tx, id: string): Promise<StudentRow | null> {
  return tx.maybeOne<StudentRow>(`select ${STUDENT_COLUMNS} from students s where s.id = $1 and s.deleted_at is null for update`, [id]);
}

/** Locks several live students (ids that are missing, deleted or foreign are simply absent). */
export function lockStudents(tx: Tx, ids: readonly string[]): Promise<{ id: string }[]> {
  return tx.many<{ id: string }>('select s.id from students s where s.id = any ($1::uuid[]) and s.deleted_at is null order by s.id for update', [ids]);
}

/** API field → column (whitelist for inserts and partial updates). */
export const STUDENT_FIELD_COLUMNS = {
  admissionNo: 'admission_no',
  fullName: 'full_name',
  className: 'class_name',
  section: 'section',
  rollNo: 'roll_no',
  notes: 'notes',
  isActive: 'is_active',
  photoFileId: 'photo_file_id',
} as const;
export type StudentField = keyof typeof STUDENT_FIELD_COLUMNS;

function entriesOf(values: Partial<Record<StudentField, unknown>>) {
  return (Object.keys(STUDENT_FIELD_COLUMNS) as StudentField[]).filter((k) => values[k] !== undefined).map((k) => [STUDENT_FIELD_COLUMNS[k], values[k]] as const);
}

export async function insertStudent(tx: Tx, values: Partial<Record<StudentField, unknown>>): Promise<StudentRow> {
  const entries = entriesOf(values);
  return tx.one<StudentRow>(
    `insert into students (school_id, created_by, ${entries.map(([c]) => c).join(', ')})
     values (nullif(current_setting('app.school_id', true), '')::uuid, nullif(current_setting('app.actor_id', true), '')::uuid,
             ${entries.map((_, i) => `$${i + 1}`).join(', ')})
     returning *`,
    entries.map(([, v]) => v),
  );
}

export async function updateStudent(tx: Tx, id: string, values: Partial<Record<StudentField, unknown>>): Promise<StudentRow> {
  const entries = entriesOf(values);
  const sets = entries.map(([c], i) => `${c} = $${i + 2}`);
  return tx.one<StudentRow>(`update students set ${sets.join(', ')}, updated_at = now() where id = $1 and deleted_at is null returning *`, [id, ...entries.map(([, v]) => v)]);
}

/** File row of a candidate photo (null when missing or in another school). */
export function findPhotoFile(tx: Tx, fileId: string) {
  return tx.maybeOne<{ id: string; category: string; status: string; entity_type: string | null; entity_id: string | null }>(
    'select id, category, status, entity_type, entity_id from files where id = $1',
    [fileId],
  );
}

/** Parent accounts linked to a student (for socket disconnects after unlink/deactivation). */
export async function linkedParentAccounts(tx: Tx, studentId: string): Promise<string[]> {
  return (await tx.many<{ id: string }>('select parent_account_id as id from student_parents where student_id = $1', [studentId])).map((r) => r.id);
}

/**
 * Soft delete in one statement: marks the student deleted, ends its effective assignments
 * (current rows end today, upcoming rows are cancelled) and removes its parent links.
 */
export function softDelete(tx: Tx, id: string) {
  return tx.one<{ assignments_ended: number; links_removed: number }>(
    `with today as (select app_local_date() as d),
     del as (update students set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null returning id),
     ended as (
       update student_assignments sa set valid_to = greatest(sa.valid_from, (select d from today))
        where sa.student_id in (select id from del) and (sa.valid_to is null or sa.valid_to > (select d from today)) returning 1),
     unlinked as (delete from student_parents where student_id in (select id from del) returning 1)
     select (select count(*)::int from ended) as assignments_ended, (select count(*)::int from unlinked) as links_removed`,
    [id],
  );
}
