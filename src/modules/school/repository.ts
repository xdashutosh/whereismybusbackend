// School module SQL (profile, settings, holidays, announcements). Receives `tx` only; every row is
// reached through RLS (tenant_isolation + schools_own_read/update), so another school's ids simply
// return no row. Inserts take school_id from the transaction context, never from input.
import type { Tx } from '../../db/tenant.js';
import { escapeLike, pagedQuery } from '../../shared/pagination.js';

const SCHOOL = "nullif(current_setting('app.school_id', true), '')::uuid";

/** `set a = $n, b = $n+1` for whitelisted columns (keys are trusted column names). */
function setClause(cols: Record<string, unknown>, offset: number): { sql: string; params: unknown[] } {
  const entries = Object.entries(cols);
  return {
    sql: entries.map(([c], i) => `${c} = $${i + offset}`).join(', '),
    params: entries.map(([, v]) => v),
  };
}

// ── profile ───────────────────────────────────────────────────────────────────
export interface ProfileRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  institution_type: 'school' | 'college' | 'university';
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  logo_file_id: string | null;
  logo_key: string | null;
  brand_color: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number;
  timezone: string;
  status: 'active' | 'suspended' | 'inactive';
  subscription: { plan: string; status: string; max_buses: number | null; max_students: number | null; valid_from: string; valid_until: string | null } | null;
  created_at: string;
  updated_at: string;
}

const PROFILE_SELECT = `select s.id, s.code, s.name, s.institution_type, s.address, s.city, s.state, s.pincode,
         s.contact_name, s.contact_phone, s.contact_email, s.logo_file_id, lf.key as logo_key, s.brand_color,
         s.latitude, s.longitude, s.geofence_radius_m, s.timezone, s.status, s.created_at, s.updated_at,
         (select jsonb_build_object('plan', ss.plan, 'status', ss.status, 'max_buses', ss.max_buses, 'max_students', ss.max_students,
                                    'valid_from', ss.valid_from, 'valid_until', ss.valid_until)
            from school_subscriptions ss where ss.school_id = s.id and ss.status = 'active'
           order by ss.created_at desc limit 1) as subscription
    from schools s
    left join files lf on lf.school_id = s.id and lf.id = s.logo_file_id and lf.status = 'uploaded'`;

export function getProfile(tx: Tx): Promise<ProfileRow | null> {
  return tx.maybeOne<ProfileRow>(`${PROFILE_SELECT} where s.id = ${SCHOOL} and s.deleted_at is null`);
}

/** Locks the school row and returns the profile before the change. */
export function lockProfile(tx: Tx): Promise<ProfileRow | null> {
  return tx.maybeOne<ProfileRow>(`${PROFILE_SELECT} where s.id = ${SCHOOL} and s.deleted_at is null for update of s`);
}

export async function updateProfile(tx: Tx, cols: Record<string, unknown>): Promise<void> {
  const { sql, params } = setClause({ ...cols }, 1);
  await tx.query(`update schools set ${sql}, updated_at = now() where id = ${SCHOOL} and deleted_at is null`, params);
}

export interface LogoFileRow extends Record<string, unknown> {
  id: string;
  category: string;
  status: string;
}

export function findFile(tx: Tx, id: string): Promise<LogoFileRow | null> {
  return tx.maybeOne<LogoFileRow>('select id, category, status from files where id = $1', [id]);
}

// ── settings ──────────────────────────────────────────────────────────────────
export interface SettingsRow extends Record<string, unknown> {
  school_id: string;
  /** `modules` of the school's active subscription (null without one); `false` keys narrow the features. */
  plan_modules?: Record<string, unknown> | null;
  location_moving_interval_s: number | null;
  location_stopped_interval_s: number | null;
  moving_speed_kmh: number | null;
  stopped_after_s: number | null;
  document_reminder_days: number[] | null;
  location_retention_months: number | null;
  allow_non_school_trips: boolean;
  allow_backup_driver_start: boolean;
  odometer_gallery_allowed: boolean;
  odometer_mismatch_threshold_km: number;
  odometer_gps_variance_pct: number;
  odometer_gps_min_km: number;
  trip_not_started_grace_min: number;
  trip_delay_threshold_min: number;
  stale_trip_close_hours: number | null;
  stop_duration_alert_min: number;
  speed_limit_kmh: number | null;
  enable_speeding_alert: boolean;
  enable_harsh_driving_alert: boolean;
  enable_route_deviation_alert: boolean;
  route_deviation_m: number;
  approaching_stop_minutes: number;
  notify_trip_not_started: boolean;
  alert_recipients: unknown[];
  features: Record<string, unknown>;
  parent_visibility: Record<string, unknown>;
  updated_by: string | null;
  updated_at: string;
  /** Readable platform defaults: { key: value } (public rows only). */
  platform: Record<string, unknown>;
}

/** Settings row of the current school + the platform defaults it falls back to (one round trip). */
export function getSettings(tx: Tx, platformKeys: readonly string[], { lock = false } = {}): Promise<SettingsRow | null> {
  return tx.maybeOne<SettingsRow>(
    `select ss.*,
            (select coalesce(jsonb_object_agg(ps.key, ps.value), '{}'::jsonb) from platform_settings ps where ps.key = any ($1::text[])) as platform,
            (select sub.modules from school_subscriptions sub where sub.school_id = ss.school_id and sub.status = 'active'
              order by sub.created_at desc limit 1) as plan_modules
       from school_settings ss
      where ss.school_id = ${SCHOOL}${lock ? ' for update of ss' : ''}`,
    [platformKeys],
  );
}

export async function updateSettings(tx: Tx, cols: Record<string, unknown>): Promise<void> {
  const { sql, params } = setClause(cols, 1);
  await tx.query(
    `update school_settings set ${sql}, updated_by = $${params.length + 1}, updated_at = now() where school_id = ${SCHOOL}`,
    [...params, tx.ctx.actorId],
  );
}

/** Active, non-deleted school admins of the current school among `ids`. */
export async function activeAdminIds(tx: Tx, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await tx.many<{ id: string }>(
    "select id from users where id = any ($1::uuid[]) and role = 'school_admin' and is_active and deleted_at is null",
    [ids],
  );
  return new Set(rows.map((r) => r.id));
}

export { escapeLike, pagedQuery, setClause, SCHOOL };
