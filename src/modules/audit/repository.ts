// Audit log reads. Rows are reached only through RLS: school rows by tenant_isolation (school
// admins/jobs; audit_readers blocks drivers, conductors and parents), platform rows (school_id
// NULL) by audit_platform_read for super admins. Writes go through shared/audit.ts.
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';

export interface AuditRow extends Record<string, unknown> {
  id: number;
  created_at: string;
  actor_type: string | null;
  actor_id: string | null;
  actor_name: string | null;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  old_values: unknown;
  new_values: unknown;
}

export interface AuditFilter {
  /** 'school' → rows of the current school; 'platform' → platform-level rows only. */
  scope: 'school' | 'platform';
  actorId?: string;
  actorType?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  fromIso?: string;
  toIso?: string;
  q?: string;
}

const SELECT = `a.id, a.created_at, a.actor_type, a.actor_id, a.actor_name, host(a.ip) as ip, a.user_agent, a.request_id,
  a.action, a.entity_type, a.entity_id, a.old_values, a.new_values`;

function where(f: AuditFilter): { sql: string; params: unknown[] } {
  const prefix = f.action && (f.action.endsWith('*') || f.action.endsWith('.'));
  const action = f.action ? (prefix ? `${escapeLike(f.action.replace(/\*$/, ''))}%` : f.action) : null;
  const scope =
    f.scope === 'platform'
      ? "a.school_id is null and a.actor_type is distinct from 'parent_account'"
      : "a.school_id = nullif(current_setting('app.school_id', true), '')::uuid";
  return {
    sql: `${scope}
      and ($1::uuid is null or a.actor_id = $1)
      and ($2::text is null or a.actor_type = $2)
      and ($3::text is null or (case when $4 then a.action like $3 else a.action = $3 end))
      and ($5::text is null or a.entity_type = $5)
      and ($6::uuid is null or a.entity_id = $6)
      and ($7::timestamptz is null or a.created_at >= $7)
      and ($8::timestamptz is null or a.created_at < $8)
      and ($9::text is null or a.action ilike '%' || $9 || '%' or a.actor_name ilike '%' || $9 || '%' or a.entity_type ilike '%' || $9 || '%')`,
    params: [
      f.actorId ?? null,
      f.actorType ?? null,
      action,
      Boolean(prefix),
      f.entityType ?? null,
      f.entityId ?? null,
      f.fromIso ?? null,
      f.toIso ?? null,
      f.q ? escapeLike(f.q) : null,
    ],
  };
}

export function page(tx: Tx, f: AuditFilter, { orderBy, limit, offset }: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<AuditRow>(tx, { select: SELECT, from: 'from audit_logs a', where: w.sql, params: w.params, orderBy, limit, offset });
}

export function exportRows(tx: Tx, f: AuditFilter, orderBy: string): Promise<AuditRow[]> {
  const w = where(f);
  return tx.many<AuditRow>(`select ${SELECT} from audit_logs a where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}
