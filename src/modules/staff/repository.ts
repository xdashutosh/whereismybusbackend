// Staff profile SQL (BP §6.2 staff_profiles + the linked users login row). Runs in the caller's
// tenant transaction: RLS limits every statement to the current school; school_id and created_by
// are written from the transaction context, never from input. Deleted profiles are invisible.
import { STAFF_DOCUMENT_EXPIRING_DAYS } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';

const EXPIRING_DAYS = Number(STAFF_DOCUMENT_EXPIRING_DAYS);
const SCHOOL = "nullif(current_setting('app.school_id', true), '')::uuid";
const ACTOR = "nullif(current_setting('app.actor_id', true), '')::uuid";

export interface StaffBusRefRow {
  busId: string;
  busCode: string;
  role: string;
}

/** List row: profile columns shown in tables plus badges computed in the same statement. */
export interface StaffListRow extends Record<string, unknown> {
  id: string;
  staff_type: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  photo_file_id: string | null;
  photo_key: string | null;
  photo_thumb_key: string | null;
  joining_date: string | null;
  experience_years: number | null;
  id_proof_type: string | null;
  id_proof_last4: string | null;
  id_verification_status: string;
  licence_no: string | null;
  licence_expiry_date: string | null;
  licence_status: string;
  licence_days_to_expiry: number | null;
  licence_verification_status: string;
  is_active: boolean;
  user_id: string | null;
  login_phone: string | null;
  login_username: string | null;
  current_buses: StaffBusRefRow[] | null;
  expired_documents: number;
  expiring_documents: number;
  created_at: string;
  updated_at: string;
}

/** Detail row: every profile column, the login state and the active trip. */
export interface StaffDetailRow extends StaffListRow {
  address: string | null;
  experience_summary: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  licence_rto: string | null;
  licence_issue_date: string | null;
  created_by: string | null;
  login_active: boolean | null;
  login_has_pin: boolean | null;
  login_must_change_password: boolean | null;
  login_locked: boolean | null;
  login_last_login_at: string | null;
  login_password_changed_at: string | null;
  login_active_sessions: number | null;
  active_trip_id: string | null;
}

const LIST_COLUMNS = `sp.id, sp.staff_type, sp.full_name, sp.phone, sp.email::text as email, sp.photo_file_id,
  pf.key as photo_key, pf.thumb_key as photo_thumb_key, sp.joining_date, sp.experience_years, sp.id_proof_type, sp.id_proof_last4,
  sp.id_verification_status, sp.licence_no, sp.licence_expiry_date,
  case when sp.licence_expiry_date is null then 'none'
       when sp.licence_expiry_date < today.day then 'expired'
       when sp.licence_expiry_date <= today.day + ${EXPIRING_DAYS} then 'expiring'
       else 'valid' end as licence_status,
  (sp.licence_expiry_date - today.day) as licence_days_to_expiry,
  sp.licence_verification_status, sp.is_active, u.id as user_id, u.phone as login_phone, u.username::text as login_username,
  cb.buses as current_buses, coalesce(dc.expired, 0) as expired_documents, coalesce(dc.expiring, 0) as expiring_documents,
  sp.created_at, sp.updated_at`;

const DETAIL_COLUMNS = `${LIST_COLUMNS}, sp.address, sp.experience_summary, sp.emergency_contact_name, sp.emergency_contact_phone,
  sp.licence_rto, sp.licence_issue_date, sp.created_by,
  u.is_active as login_active, (u.pin_hash is not null) as login_has_pin, u.must_change_password as login_must_change_password,
  coalesce(u.locked_until > now(), false) as login_locked, u.last_login_at as login_last_login_at,
  u.password_changed_at as login_password_changed_at,
  (select count(*)::int from sessions s where s.owner_type = 'user' and s.owner_id = u.id and s.revoked_at is null
      and s.rotated_at is null and s.expires_at > now()) as login_active_sessions,
  (select t.id from trips t where t.status = 'in_progress' and (t.driver_staff_id = sp.id or t.conductor_staff_id = sp.id)
     order by t.started_at desc nulls last limit 1) as active_trip_id`;

const FROM = `from staff_profiles sp
  cross join (select app_local_date() as day) today
  left join users u on u.id = sp.user_id and u.deleted_at is null
  left join files pf on pf.id = sp.photo_file_id
  left join lateral (
    select json_agg(json_build_object('busId', b.id, 'busCode', b.code, 'role', a.assignment_role) order by b.code, a.assignment_role) as buses
      from bus_staff_assignments a join buses b on b.id = a.bus_id and b.deleted_at is null
     where a.staff_id = sp.id and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
  ) cb on true
  left join lateral (
    select count(*) filter (where d.expiry_date < today.day)::int as expired,
           count(*) filter (where d.expiry_date >= today.day and d.expiry_date <= today.day + ${EXPIRING_DAYS})::int as expiring
      from staff_documents d where d.staff_id = sp.id and d.is_current and d.deleted_at is null
  ) dc on true`;

export interface StaffFilter {
  types?: string[];
  status?: 'active' | 'inactive' | 'all';
  q?: string;
  licenceStatus?: 'expired' | 'expiring' | 'missing';
  documentStatus?: 'expired' | 'expiring';
  hasLogin?: boolean;
  assigned?: boolean;
}

function where(f: StaffFilter) {
  return {
    sql: `sp.deleted_at is null
      and ($1::text[] is null or sp.staff_type = any ($1))
      and ($2::text is null or $2 = 'all' or sp.is_active = ($2 = 'active'))
      and ($3::text is null or sp.full_name ilike '%' || $3 || '%' or coalesce(sp.phone, '') like '%' || $3 || '%'
           or coalesce(sp.licence_no, '') ilike '%' || $3 || '%' or coalesce(u.username::text, '') ilike '%' || $3 || '%')
      and ($4::text is null
           or ($4 = 'missing' and sp.staff_type = 'driver' and sp.licence_expiry_date is null)
           or ($4 = 'expired' and sp.licence_expiry_date < today.day)
           or ($4 = 'expiring' and sp.licence_expiry_date >= today.day and sp.licence_expiry_date <= today.day + ${EXPIRING_DAYS}))
      and ($5::text is null or ($5 = 'expired' and dc.expired > 0) or ($5 = 'expiring' and dc.expiring > 0))
      and ($6::boolean is null or (u.id is not null) = $6)
      and ($7::boolean is null or (cb.buses is not null) = $7)`,
    params: [f.types ?? null, f.status ?? null, f.q ? escapeLike(f.q) : null, f.licenceStatus ?? null, f.documentStatus ?? null, f.hasLogin ?? null, f.assigned ?? null],
  };
}

export function page(tx: Tx, f: StaffFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<StaffListRow>(tx, { select: LIST_COLUMNS, from: FROM, where: w.sql, params: w.params, ...o });
}

export function exportRows(tx: Tx, f: StaffFilter, orderBy: string): Promise<StaffListRow[]> {
  const w = where(f);
  return tx.many<StaffListRow>(`select ${LIST_COLUMNS} ${FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

export function findDetail(tx: Tx, id: string): Promise<StaffDetailRow | null> {
  return tx.maybeOne<StaffDetailRow>(`select ${DETAIL_COLUMNS} ${FROM} where sp.id = $1 and sp.deleted_at is null`, [id]);
}

export interface StaffLockRow extends Record<string, unknown> {
  id: string;
  staff_type: string;
  full_name: string;
  phone: string | null;
  is_active: boolean;
  user_id: string | null;
  photo_file_id: string | null;
}

/** Locks a live profile for a write (serialises concurrent changes of the same staff member). */
export function lock(tx: Tx, id: string): Promise<StaffLockRow | null> {
  return tx.maybeOne<StaffLockRow>(
    'select id, staff_type, full_name, phone, is_active, user_id, photo_file_id from staff_profiles where id = $1 and deleted_at is null for update',
    [id],
  );
}

export async function exists(tx: Tx, id: string): Promise<boolean> {
  return (await tx.maybeOne('select 1 from staff_profiles where id = $1 and deleted_at is null', [id])) !== null;
}

/** API field → staff_profiles column (whitelist for inserts and partial updates). */
export const PROFILE_COLUMNS = {
  fullName: 'full_name',
  phone: 'phone',
  email: 'email',
  address: 'address',
  joiningDate: 'joining_date',
  experienceYears: 'experience_years',
  experienceSummary: 'experience_summary',
  emergencyContactName: 'emergency_contact_name',
  emergencyContactPhone: 'emergency_contact_phone',
  idProofType: 'id_proof_type',
  idProofLast4: 'id_proof_last4',
  licenceNo: 'licence_no',
  licenceRto: 'licence_rto',
  licenceIssueDate: 'licence_issue_date',
  licenceExpiryDate: 'licence_expiry_date',
  photoFileId: 'photo_file_id',
} as const;
export type ProfileField = keyof typeof PROFILE_COLUMNS;
export type ProfileValues = Partial<Record<ProfileField, string | number | null>>;

const definedEntries = (v: ProfileValues) => (Object.keys(PROFILE_COLUMNS) as ProfileField[]).filter((k) => v[k] !== undefined);

export async function insert(tx: Tx, staffType: string, v: ProfileValues): Promise<string> {
  const keys = definedEntries(v);
  const cols = keys.map((k) => PROFILE_COLUMNS[k]);
  const row = await tx.one<{ id: string }>(
    `insert into staff_profiles (school_id, staff_type, created_by${cols.map((c) => `, ${c}`).join('')})
     values (${SCHOOL}, $1, ${ACTOR}${keys.map((_, i) => `, $${i + 2}`).join('')}) returning id`,
    [staffType, ...keys.map((k) => v[k])],
  );
  return row.id;
}

export async function update(tx: Tx, id: string, v: ProfileValues): Promise<void> {
  const keys = definedEntries(v);
  if (!keys.length) return;
  await tx.query(
    `update staff_profiles set ${keys.map((k, i) => `${PROFILE_COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now()
      where id = $1 and deleted_at is null`,
    [id, ...keys.map((k) => v[k])],
  );
}

export async function setActive(tx: Tx, id: string, active: boolean): Promise<void> {
  await tx.query('update staff_profiles set is_active = $2, updated_at = now() where id = $1 and deleted_at is null', [id, active]);
}

export async function softDelete(tx: Tx, id: string): Promise<void> {
  await tx.query('update staff_profiles set deleted_at = now(), is_active = false, updated_at = now() where id = $1 and deleted_at is null', [id]);
}

export async function linkUser(tx: Tx, id: string, userId: string): Promise<void> {
  await tx.query('update staff_profiles set user_id = $2, updated_at = now() where id = $1', [id, userId]);
}

export async function setIdentityVerification(tx: Tx, id: string, column: 'id_verification_status' | 'licence_verification_status', status: string): Promise<void> {
  await tx.query(`update staff_profiles set ${column} = $2, updated_at = now() where id = $1`, [id, status]);
}

/** In-progress trip driven/conducted by this staff member (null when none). */
export async function activeTripOf(tx: Tx, id: string): Promise<string | null> {
  const row = await tx.maybeOne<{ id: string }>(
    "select id from trips where status = 'in_progress' and (driver_staff_id = $1 or conductor_staff_id = $1) limit 1",
    [id],
  );
  return row?.id ?? null;
}
