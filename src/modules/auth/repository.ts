// SQL of the auth module. Pre-authentication lookups call the SECURITY DEFINER functions of
// migration 012 through db/definer.ts (one statement, no tenant context — README §5); every
// write happens inside the acting principal's own context (withTenant / withPlatform), so RLS
// still governs it: school users → their school; super admin and parents → their school-less rows.
import type { DevicePlatform, OwnerType, Role } from '@wimb/shared';
import { definerQuery } from '../../db/definer.js';
import type { QueryResultRow } from '../../db/pool.js';
import type { Tx } from '../../db/tenant.js';

const definer = <R extends QueryResultRow>(sql: string, params: unknown[]): Promise<R[]> =>
  definerQuery<R>(sql, params, { unavailableMessage: 'Authentication is not available yet.' });

// ── OTP ──────────────────────────────────────────────────────────────────────
export async function otpRequest(p: { phone: string; purpose: string; codeHash: string; ttlSeconds: number; cooldownSeconds: number; maxAttempts: number; ip: string | null }) {
  const rows = await definer<{ status: 'issued' | 'cooldown'; retry_after_s: number }>(
    'select status, retry_after_s from otp_request($1, $2, $3, $4, $5, $6, $7::inet)',
    [p.phone, p.purpose, p.codeHash, p.ttlSeconds, p.cooldownSeconds, p.maxAttempts, p.ip],
  );
  return rows[0] ?? null;
}

export async function otpVerify(phone: string, purpose: string, codeHash: string) {
  const rows = await definer<{ status: 'ok' | 'invalid' | 'locked' | 'expired' | 'not_found' }>('select status from otp_verify($1, $2, $3)', [phone, purpose, codeHash]);
  return rows[0]?.status ?? null;
}

/** Active (school_id, student_id) links of a parent across schools (BP §4.6). */
export function parentChildren(parentId: string): Promise<{ school_id: string; student_id: string }[]> {
  return definer('select school_id, student_id from parent_children_index($1::uuid)', [parentId]);
}

// ── login lookups ────────────────────────────────────────────────────────────
export interface LockoutFields {
  id: string;
  password_hash: string | null;
  is_active: boolean;
  failed_login_count: number;
  locked_until: string | null;
}

export interface PlatformLoginRow extends LockoutFields {
  name: string;
  must_change_password: boolean;
  totp_enabled: boolean;
  totp_secret_enc: string | null;
  totp_last_used_step: number | null;
}

export interface SchoolUserLoginRow extends LockoutFields {
  school_id: string;
  school_status: string;
  school_deleted: boolean;
  full_name: string;
  must_change_password: boolean;
  role: Role;
  pin_hash: string | null;
}

export interface ParentLoginRow extends LockoutFields {
  has_active_link: boolean;
}

export async function findPlatformUser(email: string): Promise<PlatformLoginRow | null> {
  const rows = await definer<PlatformLoginRow>('select * from auth_platform_login($1::citext)', [email]);
  return rows[0] ?? null;
}

export async function findSchoolAdmin(email: string): Promise<SchoolUserLoginRow | null> {
  const rows = await definer<SchoolUserLoginRow>(
    "select *, 'school_admin'::text as role, null::text as pin_hash from auth_school_admin_login($1::citext)",
    [email],
  );
  return rows[0] ?? null;
}

export async function findStaffUser(schoolCode: string, identifier: string): Promise<SchoolUserLoginRow | null> {
  const rows = await definer<SchoolUserLoginRow>('select * from auth_staff_login($1, $2)', [schoolCode, identifier]);
  return rows[0] ?? null;
}

export async function findParent(phone: string): Promise<ParentLoginRow | null> {
  const rows = await definer<ParentLoginRow>('select * from auth_parent_login($1)', [phone]);
  return rows[0] ?? null;
}

// ── sessions ─────────────────────────────────────────────────────────────────
export interface RefreshSessionRow {
  session_id: string;
  family_id: string;
  owner_type: OwnerType;
  owner_id: string;
  school_id: string | null;
  device_id: string | null;
  client: 'web' | 'mobile';
  expires_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
}

export async function findSessionByRefreshHash(hash: string): Promise<RefreshSessionRow | null> {
  const rows = await definer<RefreshSessionRow>('select * from auth_session_by_refresh($1)', [hash]);
  return rows[0] ?? null;
}

export interface NewSession {
  ownerType: OwnerType;
  ownerId: string;
  schoolId: string | null;
  deviceId: string | null;
  familyId: string | null;
  refreshHash: string;
  client: 'web' | 'mobile';
  ip: string | null;
  userAgent: string | null;
  appName: string | null;
  appVersion: string | null;
  expiresAt: Date;
}

const LOGIN_TABLE: Record<OwnerType, string> = { platform_user: 'platform_users', user: 'users', parent_account: 'parent_accounts' };

/**
 * Inserts a session (new family unless familyId is given). With touchLogin the owner's lockout
 * counters are cleared and last_login_at is set in the same statement.
 */
export async function insertSession(tx: Tx, s: NewSession, { touchLogin = false } = {}): Promise<{ id: string; family_id: string; expires_at: string }> {
  const touch = touchLogin
    ? `with touched as (update ${LOGIN_TABLE[s.ownerType]} set failed_login_count = 0, locked_until = null, last_login_at = now() where id = $2) `
    : '';
  return tx.one(
    `${touch}insert into sessions (owner_type, owner_id, school_id, device_id, family_id, refresh_hash, client, ip, user_agent, app_name, app_version, expires_at)
     values ($1, $2, $3, $4, coalesce($5::uuid, uuid_v7()), $6, $7, $8::inet, $9, $10, $11, $12)
     returning id, family_id, expires_at`,
    [s.ownerType, s.ownerId, s.schoolId, s.deviceId, s.familyId, s.refreshHash, s.client, s.ip, s.userAgent, s.appName, s.appVersion, s.expiresAt.toISOString()],
  );
}

/** Marks a token as rotated (exactly once). → false when it was already rotated or revoked. */
export async function markRotated(tx: Tx, sessionId: string): Promise<boolean> {
  const r = await tx.query('update sessions set rotated_at = now(), last_used_at = now() where id = $1 and rotated_at is null and revoked_at is null', [sessionId]);
  return (r.rowCount ?? 0) === 1;
}

/**
 * Remembers the successor of a rotated row for the refresh grace window (migration 900): its id, its
 * encrypted refresh token and the fingerprint of the rotating client. Grace secrets of OLDER rows of
 * the family whose window has passed are wiped in the same statement.
 */
export async function recordSuccessor(tx: Tx, p: { sessionId: string; familyId: string; successorId: string; tokenEnc: string; clientFp: string; graceSeconds: number }): Promise<void> {
  await tx.query(
    `with wiped as (
       update sessions set successor_token_enc = null
        where family_id = $2 and id <> $1 and successor_token_enc is not null
          and rotated_at < now() - make_interval(secs => $6)
     )
     update sessions set successor_id = $3, successor_token_enc = $4, successor_client_fp = $5 where id = $1`,
    [p.sessionId, p.familyId, p.successorId, p.tokenEnc, p.clientFp, p.graceSeconds],
  );
}

export interface GraceSuccessorRow {
  successor_id: string;
  successor_token_enc: string | null;
  successor_client_fp: string | null;
  /** The rotation happened at most graceSeconds ago (database clock). */
  in_window: boolean;
  next_refresh_hash: string;
  next_expires_at: string;
  next_rotated_at: string | null;
  next_revoked_at: string | null;
}

/** Successor of a rotated session (own context, RLS) with its state; null when there is none. */
export function graceSuccessor(tx: Tx, sessionId: string, graceSeconds: number): Promise<GraceSuccessorRow | null> {
  return tx.maybeOne<GraceSuccessorRow>(
    `select s.successor_id, s.successor_token_enc, s.successor_client_fp,
            (s.rotated_at is not null and s.rotated_at >= now() - make_interval(secs => $2)) as in_window,
            n.refresh_hash as next_refresh_hash, n.expires_at as next_expires_at, n.rotated_at as next_rotated_at, n.revoked_at as next_revoked_at
       from sessions s
       join sessions n on n.id = s.successor_id and n.family_id = s.family_id
      where s.id = $1 and s.revoked_at is null`,
    [sessionId, graceSeconds],
  );
}

/** Revokes every live session of a rotation family → revoked session ids (grace secrets wiped). */
export async function revokeFamily(tx: Tx, familyId: string, reason: string): Promise<string[]> {
  const rows = await tx.many<{ id: string }>(
    'update sessions set revoked_at = now(), revoked_reason = $2, successor_token_enc = null where family_id = $1 and revoked_at is null returning id',
    [familyId, reason],
  );
  return rows.map((r) => r.id);
}

/** Every session id of a family (sockets may still be attached to rotated ones). */
export async function familySessionIds(tx: Tx, familyId: string): Promise<string[]> {
  return (await tx.many<{ id: string }>('select id from sessions where family_id = $1', [familyId])).map((r) => r.id);
}

/** Revokes all live sessions of an owner (optionally keeping one family) → revoked ids. */
export async function revokeOwnerSessions(tx: Tx, ownerType: OwnerType, ownerId: string, reason: string, keepFamilyId: string | null = null): Promise<string[]> {
  const rows = await tx.many<{ id: string }>(
    `update sessions set revoked_at = now(), revoked_reason = $3, successor_token_enc = null
      where owner_type = $1 and owner_id = $2 and revoked_at is null and ($4::uuid is null or family_id <> $4::uuid)
      returning id`,
    [ownerType, ownerId, reason, keepFamilyId],
  );
  return rows.map((r) => r.id);
}

/** Why a session was revoked (null when it is not revoked or not visible in this context). */
export async function revokedReasonOf(tx: Tx, sessionId: string): Promise<string | null> {
  return (await tx.maybeOne<{ revoked_reason: string | null }>('select revoked_reason from sessions where id = $1', [sessionId]))?.revoked_reason ?? null;
}

export async function familyOfSession(tx: Tx, sessionId: string): Promise<string | null> {
  return (await tx.maybeOne<{ family_id: string }>('select family_id from sessions where id = $1', [sessionId]))?.family_id ?? null;
}

// ── lockout ──────────────────────────────────────────────────────────────────
/**
 * Records one failed sign-in on the account row (mirror of the lockout counter, lockout.ts).
 * `count` = the attempt's position in the KV window (null when the KV store was unavailable: the row
 * counter is then incremented atomically instead and the Nth failure locks). `lock` = this failure
 * locks the account. A lock resets the counter. → locked_until (or null).
 */
export async function recordLoginFailure(
  tx: Tx,
  ownerType: OwnerType,
  id: string,
  { count, lock, maxFailures, lockMinutes }: { count: number | null; lock: boolean; maxFailures: number; lockMinutes: number },
): Promise<string | null> {
  if (ownerType === 'parent_account') {
    // The app role cannot read parent_accounts' lockout columns (migration 015): same rules, in the
    // SECURITY DEFINER parent_record_login_failure() (own pre-authentication context).
    const r = await tx.one<{ locked_until: string | null }>('select parent_record_login_failure($1, $2, $3, $4, $5) as locked_until', [id, count, lock, maxFailures, lockMinutes]);
    return r.locked_until;
  }
  const row = await tx.maybeOne<{ locked_until: string | null }>(
    `with v as (
       select case when $2::int is not null then $2::int
                   when t.locked_until is not null and t.locked_until <= now() then 1
                   else t.failed_login_count + 1 end as n
         from ${LOGIN_TABLE[ownerType]} t where t.id = $1
     )
     update ${LOGIN_TABLE[ownerType]} t
        set failed_login_count = case when $3 or v.n >= $4 then 0 else v.n end,
            locked_until = case when $3 or v.n >= $4 then now() + make_interval(mins => $5)
                                when t.locked_until is not null and t.locked_until <= now() then null
                                else t.locked_until end
       from v
      where t.id = $1
      returning t.locked_until`,
    [id, count, lock, maxFailures, lockMinutes],
  );
  return row?.locked_until ?? null;
}

// ── devices ──────────────────────────────────────────────────────────────────
export interface DeviceInput {
  ownerType: OwnerType;
  ownerId: string;
  schoolId: string | null;
  deviceUid: string;
  platform: DevicePlatform;
  model: string | null;
  appName: string | null;
  appVersion: string | null;
  fcmToken: string | null;
}

export interface DeviceRow {
  id: string;
  device_uid: string;
  platform: DevicePlatform;
  device_model: string | null;
  app_version: string | null;
  is_trusted: boolean;
  revoked_at: string | null;
}

/** Registers (or refreshes) the caller's device; a blocked device keeps its revoked state. */
export async function upsertDevice(tx: Tx, d: DeviceInput): Promise<DeviceRow> {
  return tx.one<DeviceRow>(
    `insert into devices (school_id, owner_type, owner_id, device_uid, platform, device_model, app_name, app_version, fcm_token, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     on conflict (owner_type, owner_id, device_uid) do update
        set platform = excluded.platform, device_model = coalesce(excluded.device_model, devices.device_model),
            app_name = coalesce(excluded.app_name, devices.app_name), app_version = coalesce(excluded.app_version, devices.app_version),
            fcm_token = coalesce(excluded.fcm_token, devices.fcm_token), last_seen_at = now()
     returning id, device_uid, platform, device_model, app_version, is_trusted, revoked_at`,
    [d.schoolId, d.ownerType, d.ownerId, d.deviceUid, d.platform, d.model, d.appName, d.appVersion, d.fcmToken],
  );
}

export async function findDevice(tx: Tx, id: string): Promise<DeviceRow | null> {
  return tx.maybeOne<DeviceRow>('select id, device_uid, platform, device_model, app_version, is_trusted, revoked_at from devices where id = $1', [id]);
}

// ── passwords ────────────────────────────────────────────────────────────────
export async function passwordHashOf(tx: Tx, ownerType: OwnerType, id: string): Promise<string | null | undefined> {
  if (ownerType === 'parent_account') {
    // Own row only, through the definer (the hash column is not readable by the app role).
    const own = await tx.maybeOne<{ id: string; password_hash: string | null }>('select pa.id, parent_self_password_hash() as password_hash from parent_accounts pa where pa.id = $1', [id]);
    return own ? own.password_hash : undefined;
  }
  const row = await tx.maybeOne<{ password_hash: string | null }>(`select password_hash from ${LOGIN_TABLE[ownerType]} where id = $1`, [id]);
  return row ? row.password_hash : undefined;
}

export async function setPassword(tx: Tx, ownerType: OwnerType, id: string, hash: string): Promise<void> {
  const mustChange = ownerType === 'parent_account' ? '' : ', must_change_password = false';
  const changedAt = ownerType === 'parent_account' ? '' : ', password_changed_at = now()';
  await tx.query(`update ${LOGIN_TABLE[ownerType]} set password_hash = $2, failed_login_count = 0, locked_until = null${mustChange}${changedAt} where id = $1`, [id, hash]);
}

// ── TOTP ─────────────────────────────────────────────────────────────────────
export async function storeTotpSecret(tx: Tx, id: string, secretEnc: string): Promise<void> {
  await tx.query('update platform_users set totp_secret_enc = $2 where id = $1 and not totp_enabled', [id, secretEnc]);
}

export async function pendingTotpSecret(tx: Tx, id: string): Promise<{ email: string; name: string; totp_secret_enc: string | null; totp_enabled: boolean; is_active: boolean } | null> {
  return tx.maybeOne('select email, name, totp_secret_enc, totp_enabled, is_active from platform_users where id = $1', [id]);
}

export async function enableTotp(tx: Tx, id: string, step: number): Promise<boolean> {
  const r = await tx.query(
    'update platform_users set totp_enabled = true, totp_enrolled_at = now(), totp_last_used_step = $2 where id = $1 and not totp_enabled and totp_secret_enc is not null',
    [id, step],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Records the accepted TOTP step (replay protection); false when a newer step was used meanwhile. */
export async function useTotpStep(tx: Tx, id: string, step: number): Promise<boolean> {
  const r = await tx.query(
    'update platform_users set totp_last_used_step = $2 where id = $1 and (totp_last_used_step is null or totp_last_used_step < $2)',
    [id, step],
  );
  return (r.rowCount ?? 0) === 1;
}
