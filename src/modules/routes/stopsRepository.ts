// Stop SQL (BP §6.2 stops). Sequences of the live stops of a route are always 1…n: inserts shift later
// stops down, deletes close the gap and reorders permute in one statement (stops_route_sequence_uq is
// DEFERRABLE INITIALLY IMMEDIATE, i.e. checked at the end of each statement). Callers hold the route
// row lock, so concurrent writers of one route serialise.
import type { Tx } from '../../db/tenant.js';
import type { StopRow } from './dto.js';

const STOP_COLUMNS = `s.id, s.route_id, s.sequence, s.name, s.code, s.landmark, s.latitude, s.longitude, s.expected_time,
  s.arrival_radius_m, s.created_at, s.updated_at`;

const WITH_STUDENTS = `${STOP_COLUMNS},
  (select count(*)::int from student_assignments sa
    where sa.stop_id = s.id and sa.valid_from <= app_local_date() and (sa.valid_to is null or sa.valid_to > app_local_date())) as student_count`;

/** Live stops of a route in sequence order (with current student counts). */
export function listStops(tx: Tx, routeId: string): Promise<StopRow[]> {
  return tx.many<StopRow>(`select ${WITH_STUDENTS} from stops s where s.route_id = $1 and s.deleted_at is null order by s.sequence`, [routeId]);
}

export function findStop(tx: Tx, routeId: string, stopId: string): Promise<StopRow | null> {
  return tx.maybeOne<StopRow>(`select ${WITH_STUDENTS} from stops s where s.id = $2 and s.route_id = $1 and s.deleted_at is null`, [routeId, stopId]);
}

/** Number of live stops and the id of a live stop using `code` (case-insensitive), if any. */
export function stopStats(tx: Tx, routeId: string, code: string | null, exceptId: string | null = null) {
  return tx.one<{ stop_count: number; code_taken_by: string | null }>(
    `select (select count(*)::int from stops where route_id = $1 and deleted_at is null) as stop_count,
            (select id from stops where route_id = $1 and deleted_at is null and $2::text is not null
                and lower(code) = lower($2) and ($3::uuid is null or id <> $3) limit 1) as code_taken_by`,
    [routeId, code, exceptId],
  );
}

export const STOP_FIELD_COLUMNS = {
  name: 'name',
  code: 'code',
  landmark: 'landmark',
  latitude: 'latitude',
  longitude: 'longitude',
  expectedTime: 'expected_time',
  arrivalRadiusM: 'arrival_radius_m',
} as const;
export type StopField = keyof typeof STOP_FIELD_COLUMNS;

function entriesOf(values: Partial<Record<StopField, unknown>>) {
  return (Object.keys(STOP_FIELD_COLUMNS) as StopField[]).filter((k) => values[k] !== undefined).map((k) => [STOP_FIELD_COLUMNS[k], values[k]] as const);
}

/** Inserts a stop at `sequence` (1…n+1), shifting the stops at and after that position down. */
export async function insertStop(tx: Tx, routeId: string, sequence: number, values: Partial<Record<StopField, unknown>>): Promise<StopRow> {
  await tx.query('update stops set sequence = sequence + 1 where route_id = $1 and deleted_at is null and sequence >= $2', [routeId, sequence]);
  const entries = entriesOf(values);
  const row = await tx.one<{ id: string }>(
    `insert into stops (school_id, route_id, sequence, ${entries.map(([c]) => c).join(', ')})
     values (nullif(current_setting('app.school_id', true), '')::uuid, $1, $2, ${entries.map((_, i) => `$${i + 3}`).join(', ')})
     returning id`,
    [routeId, sequence, ...entries.map(([, v]) => v)],
  );
  return (await findStop(tx, routeId, row.id))!;
}

export async function updateStop(tx: Tx, routeId: string, stopId: string, values: Partial<Record<StopField, unknown>>): Promise<StopRow> {
  const entries = entriesOf(values);
  await tx.query(
    `update stops set ${entries.map(([c], i) => `${c} = $${i + 3}`).join(', ')}, updated_at = now()
      where id = $2 and route_id = $1 and deleted_at is null`,
    [routeId, stopId, ...entries.map(([, v]) => v)],
  );
  return (await findStop(tx, routeId, stopId))!;
}

/** Soft-deletes a stop and closes the sequence gap in one statement. */
export async function softDeleteStop(tx: Tx, routeId: string, stopId: string): Promise<void> {
  await tx.query(
    `with del as (
       update stops set deleted_at = now(), updated_at = now() where id = $2 and route_id = $1 and deleted_at is null returning sequence
     )
     update stops s set sequence = s.sequence - 1
      where s.route_id = $1 and s.deleted_at is null and s.id <> $2 and s.sequence > (select sequence from del)`,
    [routeId, stopId],
  );
}

/** Sets sequence = position in `ids` (1-based) for every listed stop, in one statement. */
export async function applyOrder(tx: Tx, routeId: string, ids: string[]): Promise<number> {
  const res = await tx.query(
    `update stops s set sequence = x.pos::int
       from unnest($2::uuid[]) with ordinality as x(id, pos)
      where s.id = x.id and s.route_id = $1 and s.deleted_at is null and s.sequence <> x.pos`,
    [routeId, ids],
  );
  return res.rowCount ?? 0;
}

/** Current/future student assignments at a stop (block deletes). */
export async function stopStudentAssignments(tx: Tx, stopId: string): Promise<number> {
  const row = await tx.one<{ n: number }>(
    'select count(*)::int as n from student_assignments where stop_id = $1 and (valid_to is null or valid_to > app_local_date())',
    [stopId],
  );
  return row.n;
}
