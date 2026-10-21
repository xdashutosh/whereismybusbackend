// Tenant context (contract §4, BP §4.2). The ONLY way request/job code reaches the database:
//   withTenant(ctx, fn)   BEGIN [READ ONLY] → ONE `SELECT set_config(...) x3` (transaction-local)
//                         → fn(tx) → COMMIT (ROLLBACK on error). PgBouncer-safe: nothing
//                         survives the transaction, so a pooled connection never leaks context.
//   withPlatform(ctx, fn) super-admin work (actor_role = super_admin, no school → zero tenant rows)
//   withSystem(fn)        bootstrap lookups through SECURITY DEFINER functions (login, session,
//                         active_school_ids(), school_timezones(), parent_children_index()…)
// Repositories receive `tx` only — never a pool.
import type { ActorRole } from '@wimb/shared';
import { logger as rootLogger } from '../shared/logger.js';
import { getPool, isPgError, isTransientConnectionError, PG_ERROR, type Pool, type PoolClient, type QueryResult, type QueryResultRow, type TenantRef } from './pool.js';

const log = rootLogger.child({ module: 'db.tenant' });

export interface TenantContext {
  /** School of the request (null for super admin / system bootstrap work). */
  schoolId: string | null;
  /** Acting principal id (users.id, platform_users.id, parent_accounts.id) or null for jobs. */
  actorId: string | null;
  role: ActorRole;
}

export interface TxOptions {
  /** BEGIN READ ONLY (read-only requests). */
  readOnly?: boolean;
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  /** Re-run the whole transaction on 40001/40P01 (fn must be re-runnable). Default 0. */
  maxRetries?: number;
  /** Tenant routing (dedicated databases); defaults to the shared app pool. */
  tenant?: TenantRef | null;
  /** Explicit pool (tests). */
  pool?: Pool;
}

/** Transaction handle given to repositories. */
export interface Tx {
  readonly ctx: Readonly<TenantContext>;
  readonly readOnly: boolean;
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
  /** All rows. */
  many<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<R[]>;
  /** First row or null. */
  maybeOne<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<R | null>;
  /** Exactly one row expected (throws when none). */
  one<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<R>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SET_CONTEXT_SQL =
  "select set_config('app.school_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.actor_role', $3, true)";

function assertContext(ctx: TenantContext): void {
  if (ctx.schoolId !== null && !UUID_RE.test(ctx.schoolId)) throw new TypeError('withTenant: schoolId must be a UUID or null');
  if (ctx.actorId !== null && !UUID_RE.test(ctx.actorId)) throw new TypeError('withTenant: actorId must be a UUID or null');
  if (typeof ctx.role !== 'string' || !ctx.role) throw new TypeError('withTenant: role is required');
}

function beginSql({ readOnly, isolationLevel }: TxOptions): string {
  let sql = 'BEGIN';
  if (isolationLevel) sql += ` ISOLATION LEVEL ${isolationLevel.toUpperCase()}`;
  if (readOnly) sql += ' READ ONLY';
  return sql;
}

/** Wraps a client already inside a transaction (with context set) as a Tx. */
export function createTx(client: PoolClient, ctx: TenantContext, readOnly: boolean): Tx {
  const query = <R extends QueryResultRow>(text: string, params: readonly unknown[] = []) => client.query<R>(text, params as unknown[]);
  return {
    ctx: Object.freeze({ ...ctx }),
    readOnly,
    query,
    async many<R extends QueryResultRow>(text: string, params?: readonly unknown[]) {
      return (await query<R>(text, params)).rows;
    },
    async maybeOne<R extends QueryResultRow>(text: string, params?: readonly unknown[]) {
      return (await query<R>(text, params)).rows[0] ?? null;
    },
    async one<R extends QueryResultRow>(text: string, params?: readonly unknown[]) {
      const row = (await query<R>(text, params)).rows[0];
      if (row === undefined) throw new Error('Expected one row, got none');
      return row;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOnce<T>(pool: Pool, ctx: TenantContext, fn: (tx: Tx) => Promise<T>, opts: TxOptions): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    if (!isTransientConnectionError(err)) throw err;
    log.warn({ err: { message: (err as Error).message } }, 'Transient connect error; retrying once');
    await sleep(150);
    client = await pool.connect();
  }
  let broken = false;
  try {
    await client.query(beginSql(opts));
    await client.query(SET_CONTEXT_SQL, [ctx.schoolId ?? '', ctx.actorId ?? '', ctx.role]);
    const result = await fn(createTx(client, ctx, Boolean(opts.readOnly)));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    if (isTransientConnectionError(err)) broken = true;
    throw err;
  } finally {
    client.release(broken); // destroy broken connections instead of returning them to the pool
  }
}

/** Runs fn(tx) in one transaction with the tenant context set (see header). */
export async function withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  assertContext(ctx);
  const pool = opts.pool ?? getPool(opts.tenant);
  const maxRetries = opts.maxRetries ?? 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runOnce(pool, ctx, fn, opts);
    } catch (err) {
      const retryable = isPgError(err, PG_ERROR.SERIALIZATION_FAILURE) || isPgError(err, PG_ERROR.DEADLOCK_DETECTED);
      if (!retryable || attempt >= maxRetries) throw err;
      await sleep(20 + Math.floor(Math.random() * 80) * (attempt + 1));
    }
  }
}

/** Super-admin work: platform tables only (RLS yields zero tenant rows without app.school_id). */
export function withPlatform<T>(ctx: { actorId: string | null }, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  return withTenant({ schoolId: null, actorId: ctx.actorId, role: 'super_admin' }, fn, opts);
}

/** Bootstrap work through SECURITY DEFINER functions (no school, no actor, actor_role=system). */
export function withSystem<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  return withTenant({ schoolId: null, actorId: null, role: 'system' }, fn, opts);
}

/** Per-school job work: tenant context of one school with the system actor. */
export function withSchoolSystem<T>(schoolId: string, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  return withTenant({ schoolId, actorId: null, role: 'system' }, fn, opts);
}
