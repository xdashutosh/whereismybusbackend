// SQL of the platform module, PLATFORM scope: every statement runs inside withPlatform (actor_role =
// super_admin, no app.school_id), so RLS exposes only schools, school_subscriptions,
// platform_settings and platform audit rows — tenant tables return zero rows by construction
// (BP §4.4). School admins, usage and health come from the SECURITY DEFINER functions of migration
// 013, which return a school's admin accounts or counts only.
import type { InstitutionType, SchoolStatus, TenantMode } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';

export type SchoolRow = {
  id: string;
  code: string;
  name: string;
  institution_type: InstitutionType;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  logo_file_id: string | null;
  brand_color: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number;
  timezone: string;
  status: SchoolStatus;
  status_reason: string | null;
  tenant_mode: TenantMode;
  db_connection_ref: string | null;
  deleted_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export interface SubscriptionRow {
  id: string;
  school_id: string;
  plan: string;
  status: 'active' | 'expired' | 'cancelled';
  max_buses: number | null;
  max_students: number | null;
  modules: Record<string, boolean>;
  valid_from: string;
  valid_until: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** School list row: the school plus its current subscription summary (one query). */
export type SchoolListRow = SchoolRow & { sub_plan: string | null; sub_status: string | null; sub_valid_until: string | null; sub_max_buses: number | null; sub_max_students: number | null };

const SCHOOL_COLUMNS = `s.id, s.code, s.name, s.institution_type, s.address, s.city, s.state, s.pincode, s.contact_name,
  s.contact_phone, s.contact_email, s.logo_file_id, s.brand_color, s.latitude, s.longitude, s.geofence_radius_m, s.timezone,
  s.status, s.status_reason, s.tenant_mode, s.db_connection_ref, s.deleted_at, s.created_by, s.created_at, s.updated_at`;

/** Latest subscription row of each school (the active one when it exists). */
const CURRENT_SUBSCRIPTION_JOIN = `left join lateral (
    select x.plan, x.status, x.valid_until, x.max_buses, x.max_students from school_subscriptions x
     where x.school_id = s.id order by (x.status = 'active') desc, x.created_at desc, x.id desc limit 1
  ) sub on true`;

export interface SchoolFilter {
  q?: string;
  statuses?: readonly SchoolStatus[];
  institutionTypes?: readonly InstitutionType[];
  includeDeleted?: boolean;
}

function schoolWhere(f: SchoolFilter): { where: string; params: unknown[] } {
  return {
    where: `($1::boolean or s.deleted_at is null)
      and ($2::text[] is null or s.status = any ($2::text[]))
      and ($3::text[] is null or s.institution_type = any ($3::text[]))
      and ($4::text is null or s.name ilike '%' || $4 || '%' or s.code ilike '%' || $4 || '%' or s.city ilike '%' || $4 || '%')`,
    params: [f.includeDeleted ?? false, f.statuses?.length ? f.statuses : null, f.institutionTypes?.length ? f.institutionTypes : null, f.q ? escapeLike(f.q) : null],
  };
}

const LIST_SELECT = `${SCHOOL_COLUMNS}, sub.plan as sub_plan, sub.status as sub_status, sub.valid_until as sub_valid_until,
  sub.max_buses as sub_max_buses, sub.max_students as sub_max_students`;

export function pageSchools(tx: Tx, f: SchoolFilter, o: { orderBy: string; limit: number; offset: number }) {
  const { where, params } = schoolWhere(f);
  return pagedQuery<SchoolListRow>(tx, { select: LIST_SELECT, from: `from schools s ${CURRENT_SUBSCRIPTION_JOIN}`, where, params, orderBy: o.orderBy, limit: o.limit, offset: o.offset });
}

export function exportSchools(tx: Tx, f: SchoolFilter, orderBy: string): Promise<SchoolListRow[]> {
  const { where, params } = schoolWhere(f);
  return tx.many<SchoolListRow>(`select ${LIST_SELECT} from schools s ${CURRENT_SUBSCRIPTION_JOIN} where ${where} ${orderBy} limit ${MAX_EXPORT_ROWS}`, params);
}

export function findSchool(tx: Tx, id: string, { lock = false } = {}): Promise<SchoolRow | null> {
  return tx.maybeOne<SchoolRow>(`select ${SCHOOL_COLUMNS} from schools s where s.id = $1${lock ? ' for update' : ''}`, [id]);
}

/** Columns a platform write may set (API field → column); values are bound parameters. */
export const SCHOOL_WRITABLE = {
  code: 'code',
  name: 'name',
  institutionType: 'institution_type',
  address: 'address',
  city: 'city',
  state: 'state',
  pincode: 'pincode',
  contactName: 'contact_name',
  contactPhone: 'contact_phone',
  contactEmail: 'contact_email',
  brandColor: 'brand_color',
  latitude: 'latitude',
  longitude: 'longitude',
  geofenceRadiusM: 'geofence_radius_m',
  timezone: 'timezone',
  tenantMode: 'tenant_mode',
  dbConnectionRef: 'db_connection_ref',
  logoFileId: 'logo_file_id',
} as const;
export type SchoolWritable = Partial<Record<keyof typeof SCHOOL_WRITABLE, unknown>>;

function columnsOf(values: SchoolWritable): { cols: string[]; params: unknown[] } {
  const cols: string[] = [];
  const params: unknown[] = [];
  for (const [field, column] of Object.entries(SCHOOL_WRITABLE)) {
    const v = values[field as keyof SchoolWritable];
    if (v === undefined) continue;
    cols.push(column);
    params.push(v);
  }
  return { cols, params };
}

/** Inserts a school; the schools_create_settings trigger adds its school_settings row (defaults). */
export function insertSchool(tx: Tx, values: SchoolWritable): Promise<SchoolRow> {
  const { cols, params } = columnsOf(values);
  const placeholders = params.map((_, i) => `$${i + 1}`);
  return tx.one<SchoolRow>(
    `insert into schools as s (${[...cols, 'created_by'].join(', ')})
     values (${[...placeholders, `nullif(current_setting('app.actor_id', true), '')::uuid`].join(', ')})
     returning ${SCHOOL_COLUMNS}`,
    params,
  );
}

export function updateSchool(tx: Tx, id: string, values: SchoolWritable): Promise<SchoolRow> {
  const { cols, params } = columnsOf(values);
  if (!cols.length) throw new TypeError('updateSchool: nothing to update');
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  return tx.one<SchoolRow>(`update schools as s set ${sets} where s.id = $1 returning ${SCHOOL_COLUMNS}`, [id, ...params]);
}

export function setStatus(tx: Tx, id: string, status: SchoolStatus, reason: string | null): Promise<SchoolRow> {
  return tx.one<SchoolRow>(`update schools as s set status = $2, status_reason = $3 where s.id = $1 returning ${SCHOOL_COLUMNS}`, [id, status, reason]);
}

export function softDelete(tx: Tx, id: string, reason: string | null): Promise<SchoolRow> {
  return tx.one<SchoolRow>(`update schools as s set deleted_at = now(), status_reason = coalesce($2, s.status_reason) where s.id = $1 returning ${SCHOOL_COLUMNS}`, [id, reason]);
}

/**
 * Transaction timestamp with full microsecond precision (now() is constant inside a transaction;
 * the timestamptz type parser would round it to milliseconds) — used to find the rows a
 * definer function stamped with now() in this transaction.
 */
export async function txNowExact(tx: Tx): Promise<string> {
  return (await tx.one<{ now: string }>(`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`)).now;
}

// ── school admins / sessions (SECURITY DEFINER, super_admin only) ────────────────────────────────
export interface SchoolAdminRow {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
}

export function schoolAdmins(tx: Tx, schoolId: string): Promise<SchoolAdminRow[]> {
  return tx.many<SchoolAdminRow>(
    'select id, full_name, email, phone, is_active, must_change_password, last_login_at, created_at from platform_school_admins($1)',
    [schoolId],
  );
}

/** Creates a school_admin (must change the password at first sign-in) → user id. */
export async function createSchoolAdmin(tx: Tx, a: { schoolId: string; name: string; email: string; passwordHash: string; phone: string | null }): Promise<string> {
  const row = await tx.one<{ id: string }>('select platform_create_school_admin($1, $2, $3, $4, $5) as id', [a.schoolId, a.name, a.email, a.passwordHash, a.phone]);
  return row.id;
}

/** New temporary password, forced change, lockout cleared, sessions revoked ('password_reset'). */
export async function resetSchoolAdminPassword(tx: Tx, schoolId: string, userId: string, passwordHash: string): Promise<boolean> {
  const row = await tx.one<{ ok: boolean }>('select platform_reset_school_admin_password($1, $2, $3) as ok', [schoolId, userId, passwordHash]);
  return row.ok;
}

/** Revokes every live session of the school's users → number revoked. */
export async function revokeSchoolSessions(tx: Tx, schoolId: string, reason: string): Promise<number> {
  const row = await tx.one<{ n: number }>('select platform_revoke_school_sessions($1, $2) as n', [schoolId, reason]);
  return Number(row.n);
}

// ── counts only (BP §4.4, §20 #3) ───────────────────────────────────────────────────────────────
export interface UsageCountsRow {
  buses: number;
  students: number;
  staff: number;
  parents: number;
  routes: number;
  active_trips: number;
  trips_last_30_days: number;
  last_activity_at: string | null;
}

export function usageCounts(tx: Tx, schoolId: string): Promise<UsageCountsRow> {
  return tx.one<UsageCountsRow>('select buses, students, staff, parents, routes, active_trips, trips_last_30_days, last_activity_at from school_usage_counts($1)', [schoolId]);
}

export interface HealthCountsRow {
  schools_total: number;
  schools_active: number;
  schools_suspended: number;
  schools_inactive: number;
  buses_total: number;
  active_trips: number;
  trips_last_24h: number;
  students_total: number;
  parents_total: number;
  staff_total: number;
}

export function healthCounts(tx: Tx): Promise<HealthCountsRow> {
  return tx.one<HealthCountsRow>('select * from platform_health_counts()');
}

export type UsageListRow = Pick<SchoolRow, 'id' | 'code' | 'name' | 'status' | 'institution_type'> &
  UsageCountsRow & { sub_plan: string | null; sub_status: string | null; sub_valid_until: string | null; sub_max_buses: number | null; sub_max_students: number | null };

const USAGE_SELECT = `s.id, s.code, s.name, s.status, s.institution_type, u.buses, u.students, u.staff, u.parents, u.routes, u.active_trips,
  u.trips_last_30_days, u.last_activity_at, sub.plan as sub_plan, sub.status as sub_status, sub.valid_until as sub_valid_until,
  sub.max_buses as sub_max_buses, sub.max_students as sub_max_students`;

/** Per-school counts in ONE statement (school_usage_counts() laterally joined per page row). */
export async function usagePage(tx: Tx, f: SchoolFilter, o: { orderBy: string; limit: number; offset: number }): Promise<{ rows: UsageListRow[]; total: number }> {
  const { where, params } = schoolWhere(f);
  const n = params.length;
  const rows = await tx.many<UsageListRow & { total: number }>(
    `with page as (
       select s.*, count(*) over () as total from schools s where ${where} ${o.orderBy} limit $${n + 1} offset $${n + 2}
     )
     select ${USAGE_SELECT}, s.total from page s
     cross join lateral school_usage_counts(s.id) u
     ${CURRENT_SUBSCRIPTION_JOIN}
     ${o.orderBy}`,
    [...params, o.limit, o.offset],
  );
  const total = rows[0] ? Number(rows[0].total) : o.offset > 0 ? Number((await tx.one<{ n: number }>(`select count(*) as n from schools s where ${where}`, params)).n) : 0;
  return { rows: rows.map(({ total: _t, ...r }) => r), total };
}

export function usageExport(tx: Tx, f: SchoolFilter, orderBy: string): Promise<UsageListRow[]> {
  const { where, params } = schoolWhere(f);
  return tx.many<UsageListRow>(
    `select ${USAGE_SELECT} from (select s.* from schools s where ${where} ${orderBy} limit ${MAX_EXPORT_ROWS}) s
     cross join lateral school_usage_counts(s.id) u
     ${CURRENT_SUBSCRIPTION_JOIN}
     ${orderBy}`,
    params,
  );
}

// ── subscriptions (platform-managed rows; super admins write, schools read their own) ───────────
const SUBSCRIPTION_COLUMNS = 'id, school_id, plan, status, max_buses, max_students, modules, valid_from, valid_until, notes, created_by, created_at, updated_at';

/** The active subscription, else the most recent one. */
export function currentSubscription(tx: Tx, schoolId: string, { lock = false } = {}): Promise<SubscriptionRow | null> {
  return tx.maybeOne<SubscriptionRow>(
    `select ${SUBSCRIPTION_COLUMNS} from school_subscriptions where school_id = $1
      order by (status = 'active') desc, created_at desc, id desc limit 1${lock ? ' for update' : ''}`,
    [schoolId],
  );
}

export function subscriptionHistory(tx: Tx, schoolId: string, limit = 20): Promise<SubscriptionRow[]> {
  return tx.many<SubscriptionRow>(`select ${SUBSCRIPTION_COLUMNS} from school_subscriptions where school_id = $1 order by created_at desc, id desc limit $2`, [schoolId, limit]);
}

export interface SubscriptionValues {
  plan: string;
  status: SubscriptionRow['status'];
  maxBuses: number | null;
  maxStudents: number | null;
  modules: Record<string, boolean>;
  validFrom: string | null;
  validUntil: string | null;
  notes: string | null;
}

/** valid_from NULL → the school-local date (trigger of migration 014). */
export function insertSubscription(tx: Tx, schoolId: string, v: SubscriptionValues): Promise<SubscriptionRow> {
  return tx.one<SubscriptionRow>(
    `insert into school_subscriptions (school_id, plan, status, max_buses, max_students, modules, valid_from, valid_until, notes, created_by)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::date, $8::date, $9, nullif(current_setting('app.actor_id', true), '')::uuid)
     returning ${SUBSCRIPTION_COLUMNS}`,
    [schoolId, v.plan, v.status, v.maxBuses, v.maxStudents, JSON.stringify(v.modules), v.validFrom, v.validUntil, v.notes],
  );
}

export function updateSubscription(tx: Tx, id: string, v: SubscriptionValues): Promise<SubscriptionRow> {
  return tx.one<SubscriptionRow>(
    `update school_subscriptions set plan = $2, status = $3, max_buses = $4, max_students = $5, modules = $6::jsonb,
            valid_from = coalesce($7::date, valid_from), valid_until = $8::date, notes = $9
      where id = $1 returning ${SUBSCRIPTION_COLUMNS}`,
    [id, v.plan, v.status, v.maxBuses, v.maxStudents, JSON.stringify(v.modules), v.validFrom, v.validUntil, v.notes],
  );
}

// ── platform settings ───────────────────────────────────────────────────────────────────────────
export interface SettingRow {
  key: string;
  value: unknown;
  description: string | null;
  is_public: boolean;
  updated_by: string | null;
  updated_at: string;
}

export function listSettings(tx: Tx, { lock = false } = {}): Promise<SettingRow[]> {
  return tx.many<SettingRow>(`select key, value, description, is_public, updated_by, updated_at from platform_settings order by key${lock ? ' for update' : ''}`);
}

/** Upserts several settings in one statement (defaults supply description/visibility for new keys). */
export function upsertSettings(tx: Tx, rows: { key: string; value: unknown; description: string; isPublic: boolean }[]): Promise<SettingRow[]> {
  return tx.many<SettingRow>(
    `insert into platform_settings (key, value, description, is_public, updated_by, updated_at)
     select k, v, d, p, nullif(current_setting('app.actor_id', true), '')::uuid, now()
       from unnest($1::text[], $2::jsonb[], $3::text[], $4::boolean[]) as t(k, v, d, p)
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()
     returning key, value, description, is_public, updated_by, updated_at`,
    [rows.map((r) => r.key), rows.map((r) => JSON.stringify(r.value)), rows.map((r) => r.description), rows.map((r) => r.isPublic)],
  );
}
