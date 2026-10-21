// SQL the platform module runs INSIDE one school's context (withTenant { schoolId, role: 'system' }),
// for the few platform operations that touch tenant rows by design:
//   • the school logo — files rows only exist in a tenant context (BP §12), so the logo upload is
//     stored in the school's own scope and linked through schools.logo_file_id;
//   • session bookkeeping after a deactivation / password reset — the ids of the sessions the
//     platform functions just revoked (for realtime.disconnectSessions) and the parents whose only
//     active school was this one (their sessions are revoked through the auth module).
// Nothing read here is returned to the Super Admin except the logo's signed URL.
import type { Tx } from '../../db/tenant.js';

export interface LogoFileRow {
  id: string;
  key: string;
  thumb_key: string | null;
  status: string;
}

export function logoFile(tx: Tx, fileId: string): Promise<LogoFileRow | null> {
  return tx.maybeOne<LogoFileRow>("select id, key, thumb_key, status from files where id = $1 and category = 'school_logo'", [fileId]);
}

export interface NewLogoFile {
  key: string;
  thumbKey: string | null;
  mime: string;
  sizeBytes: number;
  sha256: string;
  originalName: string | null;
  metadata: Record<string, unknown>;
}

/** Registers the uploaded logo in the school's files (uploaded by the platform user in tx.ctx). */
export function insertLogoFile(tx: Tx, f: NewLogoFile): Promise<LogoFileRow> {
  return tx.one<LogoFileRow>(
    `insert into files (school_id, key, thumb_key, category, entity_type, entity_id, mime, size_bytes, sha256, original_name, metadata, status, uploaded_by, uploader_type)
     values (nullif(current_setting('app.school_id', true), '')::uuid, $1, $2, 'school_logo', 'school',
             nullif(current_setting('app.school_id', true), '')::uuid, $3, $4, $5, $6, $7::jsonb, 'uploaded',
             nullif(current_setting('app.actor_id', true), '')::uuid, 'platform_user')
     returning id, key, thumb_key, status`,
    [f.key, f.thumbKey, f.mime, f.sizeBytes, f.sha256, f.originalName, JSON.stringify(f.metadata)],
  );
}

/** Links (or clears) the logo of the current school; returns the previous file id. */
export async function setLogo(tx: Tx, fileId: string | null): Promise<{ previous: string | null }> {
  const row = await tx.one<{ previous: string | null }>(
    `update schools s set logo_file_id = $1
       from (select id, logo_file_id as previous from schools where id = nullif(current_setting('app.school_id', true), '')::uuid for update) old
      where s.id = old.id
      returning old.previous`,
    [fileId],
  );
  return row;
}

/** A replaced logo is no longer served (row kept for the audit trail; the object is deleted). */
export async function retireFile(tx: Tx, fileId: string): Promise<LogoFileRow | null> {
  return tx.maybeOne<LogoFileRow>("update files set status = 'deleted' where id = $1 and category = 'school_logo' returning id, key, thumb_key, status", [fileId]);
}

/**
 * Ids of the sessions revoked in one platform transaction: same school, same reason, same
 * transaction timestamp (revoked_at = now() of that transaction) — optionally one owner.
 */
export async function revokedSessionIds(tx: Tx, m: { reason: string; at: string; ownerId?: string | null }): Promise<string[]> {
  const rows = await tx.many<{ id: string }>(
    `select id from sessions
      where school_id = nullif(current_setting('app.school_id', true), '')::uuid
        and revoked_reason = $1 and revoked_at = $2::timestamptz and ($3::uuid is null or owner_id = $3::uuid)`,
    [m.reason, m.at, m.ownerId ?? null],
  );
  return rows.map((r) => r.id);
}

/**
 * Parents linked to the current school who no longer have an active link in any ACTIVE school
 * (auth_parent_login().has_active_link — the same rule that gates parent sign-in). Parents with
 * children in another active school keep their sessions: this school is already closed to them by
 * resolveTenant (X-School-Id) and the parent children index.
 */
export async function parentsWithoutActiveSchool(tx: Tx): Promise<string[]> {
  const rows = await tx.many<{ id: string }>(
    `select distinct pa.id
       from school_parents sp
       join parent_accounts pa on pa.id = sp.parent_account_id
       cross join lateral auth_parent_login(pa.phone) l
      where sp.school_id = nullif(current_setting('app.school_id', true), '')::uuid
        and sp.deleted_at is null and not l.has_active_link`,
  );
  return rows.map((r) => r.id);
}
