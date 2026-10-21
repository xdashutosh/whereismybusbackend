// Audit trail (contract §5, BP §6.2/§16): every write calls
//   await audit.log(tx, { action: 'bus.create', entityType: 'bus', entityId, old, new })
// inside the SAME transaction as the change. school_id/actor come from the transaction context;
// ip, user agent, request id and actor name from the request context. Secrets are redacted recursively.
// audit_logs is INSERT/SELECT-only for the app role (db:setup-roles).
import type { ActorRole } from '@wimb/shared';
import type { Tx } from '../db/tenant.js';
import { getRequestContext } from './requestContext.js';

export interface AuditEntry {
  /** '<entity>.<verb>', e.g. 'school.create', 'bus_document.replace'. */
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  old?: unknown;
  new?: unknown;
  /** Overrides the request-context actor name (e.g. jobs). */
  actorName?: string | null;
}

export const REDACTED = '[REDACTED]';

// Keys are split into words (camelCase, PascalCase/ACRONYMS, snake_case, kebab-case, dots, digits) and
// redacted when a word is a secret term, so `passwordHash`, `refresh_token`, `TOTPSecret`, `x-api-key`
// are hidden while ordinary business fields that merely contain those letters (`pincode`,
// `passengerCount`, `compass`, `spinner`) stay in the audit trail.
const SECRET_WORDS = new Set([
  'password', 'passwords', 'passwd', 'pwd', 'passphrase', 'pass',
  'secret', 'secrets', 'token', 'tokens', 'jwt', 'otp', 'otps', 'otpauth', 'pin', 'pins',
  'hash', 'hashes', 'totp', 'authorization', 'bearer', 'cookie', 'cookies', 'credential', 'credentials',
  'privatekey', 'apikey', 'accesskey', 'secretkey',
]);
const SECRET_PAIRS = new Set(['private key', 'api key', 'access key', 'secret key', 'client secret']);

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** True when an object key names a secret (word-based, see SECRET_WORDS). */
export function isSecretKey(key: string): boolean {
  const words = keyWords(key);
  for (let i = 0; i < words.length; i += 1) {
    if (SECRET_WORDS.has(words[i]!)) return true;
    if (i > 0 && SECRET_PAIRS.has(`${words[i - 1]} ${words[i]}`)) return true;
  }
  return false;
}

/** Deep copy with secret-looking keys replaced by [REDACTED]. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth > 8) return '[TRUNCATED]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = isSecretKey(k) ? REDACTED : redactSecrets(v, depth + 1);
  return out;
}

/** Only the keys whose values differ (shallow), for compact before/after records. */
export function changedFields(oldValues: Record<string, unknown> | null | undefined, newValues: Record<string, unknown> | null | undefined) {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(oldValues ?? {}), ...Object.keys(newValues ?? {})]);
  for (const k of keys) {
    const a = oldValues?.[k] ?? null; // absent and null are the same "no value"
    const b = newValues?.[k] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      before[k] = a;
      after[k] = b;
    }
  }
  return { old: before, new: after };
}

export function actorTypeOf(role: ActorRole): 'platform_user' | 'user' | 'parent_account' | 'system' {
  if (role === 'super_admin') return 'platform_user';
  if (role === 'parent') return 'parent_account';
  if (role === 'system') return 'system';
  return 'user';
}

export const AUDIT_INSERT_SQL = `insert into audit_logs
  (school_id, actor_type, actor_id, actor_name, ip, user_agent, action, entity_type, entity_id, old_values, new_values, request_id)
  values ($1, $2, $3, $4, $5::inet, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)`;

const toJson = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(redactSecrets(v)));

/** Appends one audit row inside `tx`. */
export async function log(tx: Tx, entry: AuditEntry): Promise<void> {
  if (!entry.action || !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(entry.action)) throw new TypeError(`Invalid audit action: ${entry.action}`);
  const rc = getRequestContext();
  await tx.query(AUDIT_INSERT_SQL, [
    tx.ctx.schoolId,
    actorTypeOf(tx.ctx.role),
    tx.ctx.actorId,
    entry.actorName ?? rc?.actorName ?? null,
    rc?.ip ?? null,
    rc?.userAgent ? rc.userAgent.slice(0, 512) : null,
    entry.action,
    entry.entityType ?? null,
    entry.entityId ?? null,
    toJson(entry.old),
    toJson(entry.new),
    rc?.requestId ? rc.requestId.slice(0, 128) : null,
  ]);
}

export const audit = { log, redactSecrets, changedFields };
export default audit;
