// PostgreSQL pools (contract §3: Neon PostgreSQL 18 behind PgBouncer transaction pooling).
// - owner pool: migrations, seeds, setup-roles only (never used by request handling)
// - app pool:   runtime (API, sockets, worker) as the LOGIN NOBYPASSRLS app role
// - getPool(tenant): the pool for a tenant (all 'shared' today; 'dedicated' hook — BP §4.7)
// No session state outside transactions; tenant context is transaction-local (db/tenant.ts).
// Type parsers: DATE/TIME stay strings, INT8/NUMERIC → Number, timestamptz → ISO-8601 string.
import pg from 'pg';
import config, { type DbConnection } from '../config/index.js';
import { serviceUnavailable } from '../shared/errors.js';
import { logger as rootLogger, type Logger } from '../shared/logger.js';

const { Pool, types } = pg;
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResult<R extends pg.QueryResultRow = pg.QueryResultRow> = pg.QueryResult<R>;
export type QueryResultRow = pg.QueryResultRow;

const log = rootLogger.child({ module: 'db' });

// ── type parsers (process-wide) ──────────────────────────────────────────────
export const OID = Object.freeze({
  INT8: 20,
  DATE: 1082,
  TIME: 1083,
  TIMESTAMPTZ: 1184,
  TIMETZ: 1266,
  NUMERIC: 1700,
  INT8_ARRAY: 1016,
  DATE_ARRAY: 1182,
  TIME_ARRAY: 1183,
  TIMESTAMPTZ_ARRAY: 1185,
  NUMERIC_ARRAY: 1231,
});

const asString = (v: string): string => v;
const asNumber = (v: string | null): number | null => (v === null ? null : Number(v));
const pgTimestamptz = types.getTypeParser(OID.TIMESTAMPTZ) as (v: string) => Date | number;

/** Postgres timestamptz text → ISO-8601 (UTC, millisecond precision); ±infinity stay strings. */
export function timestamptzToIso(v: string): string {
  const d = pgTimestamptz(v);
  if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  return v;
}

// pg-types' arrayParser typings do not match its runtime ({ create(source, transform).parse() }).
const arrayParser = types.arrayParser as unknown as { create(source: string, transform: (v: string) => unknown): { parse(): unknown[] } };
const setParser = (oid: number, parse: (v: string) => unknown): void =>
  types.setTypeParser(oid, parse);

let parsersInstalled = false;
export function installTypeParsers(): void {
  if (parsersInstalled) return;
  parsersInstalled = true;
  const arrayOf = (parse: (v: string) => unknown) => (v: string) => arrayParser.create(v, parse).parse();
  setParser(OID.DATE, asString); // 'YYYY-MM-DD' — never shifted by the process timezone
  setParser(OID.TIME, asString); // 'HH:MM:SS'
  setParser(OID.TIMETZ, asString);
  setParser(OID.INT8, asNumber);
  setParser(OID.NUMERIC, asNumber);
  setParser(OID.TIMESTAMPTZ, timestamptzToIso);
  setParser(OID.INT8_ARRAY, arrayOf(asNumber));
  setParser(OID.NUMERIC_ARRAY, arrayOf(asNumber));
  setParser(OID.DATE_ARRAY, arrayOf(asString));
  setParser(OID.TIME_ARRAY, arrayOf(asString));
  setParser(OID.TIMESTAMPTZ_ARRAY, arrayOf(timestamptzToIso));
}
installTypeParsers();

// ── errors ───────────────────────────────────────────────────────────────────
/** SQLSTATE codes referenced across the code base. */
export const PG_ERROR = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  INVALID_TEXT_REPRESENTATION: '22P02',
  INVALID_DATETIME_FORMAT: '22007',
  DATETIME_FIELD_OVERFLOW: '22008',
  NUMERIC_VALUE_OUT_OF_RANGE: '22003',
  STRING_DATA_RIGHT_TRUNCATION: '22001',
  INSUFFICIENT_PRIVILEGE: '42501',
  UNDEFINED_TABLE: '42P01',
  UNDEFINED_FUNCTION: '42883',
  READ_ONLY_SQL_TRANSACTION: '25006',
  RAISE_EXCEPTION: 'P0001',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014',
  ADMIN_SHUTDOWN: '57P01',
});

export interface PgErrorLike {
  code?: string;
  constraint?: string;
  column?: string;
  table?: string;
  detail?: string;
  severity?: string;
  message?: string;
  position?: string;
}

export function isPgError(err: unknown, code?: string): err is PgErrorLike {
  if (!err || typeof err !== 'object') return false;
  const e = err as PgErrorLike;
  if (typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) return false;
  return code === undefined || e.code === code;
}

const TRANSIENT_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);
const TRANSIENT_MESSAGES = [
  'connection terminated',
  'terminating connection',
  'client has encountered a connection error',
  'timeout exceeded when trying to connect',
  'connection timeout',
  'server closed the connection unexpectedly',
];

/** True for errors caused by a lost/unavailable connection. */
export function isTransientConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return TRANSIENT_MESSAGES.some((m) => msg.includes(m));
}

// ── pool lifecycle ───────────────────────────────────────────────────────────
export interface CreatePoolOptions {
  max?: number;
  applicationName?: string;
  logger?: Logger;
}

/** Builds a pg Pool from a connection descriptor. */
export function createPool(conn: DbConnection | null, { max, applicationName = 'whereismybus', logger = log }: CreatePoolOptions = {}): Pool {
  if (!conn) throw new Error('Database is not configured');
  const options: pg.PoolConfig = {
    max: max ?? conn.max,
    connectionTimeoutMillis: 15000, // Neon cold start
    idleTimeoutMillis: 30000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    application_name: applicationName,
  };
  if (conn.connectionString) {
    options.connectionString = conn.connectionString;
  } else {
    Object.assign(options, {
      host: conn.host,
      port: conn.port,
      user: conn.user ?? undefined,
      password: conn.password,
      database: conn.database,
      ssl: conn.ssl ?? false,
    });
  }
  const pool = new Pool(options);
  // Idle-client errors (server restart, network drop) must never crash the process.
  pool.on('error', (err: Error & { code?: string }) => {
    logger.error({ err: { message: err.message, code: err.code } }, 'PostgreSQL idle client error');
  });
  return pool;
}

let appPool: Pool | null = null;
let ownerPool: Pool | null = null;
const dedicatedPools = new Map<string, Pool>();

/** Runtime pool (app role, RLS enforced). Lazily created from config.db.app. */
export function getAppPool(): Pool {
  if (!appPool) {
    if (!config.db.app) throw new Error('App database connection is not configured (DATABASE_APP_URL or DB_APP_USER/DB_APP_PASSWORD)');
    appPool = createPool(config.db.app, { applicationName: 'whereismybus-app' });
  }
  return appPool;
}

/** Owner pool (migrations, seeds, setup-roles, test harness). Never used for request handling. */
export function getOwnerPool(): Pool {
  if (!ownerPool) ownerPool = createPool(config.db.owner, { max: 2, applicationName: 'whereismybus-owner' });
  return ownerPool;
}

/** Tenant routing descriptor (BP §4.7): schools.tenant_mode + schools.db_connection_ref. */
export interface TenantRef {
  tenantMode?: 'shared' | 'dedicated' | null;
  dbConnectionRef?: string | null;
}

/** Registers the pool of a dedicated tenant database (ref = schools.db_connection_ref). */
export function registerDedicatedPool(ref: string, conn: DbConnection): Pool {
  const existing = dedicatedPools.get(ref);
  if (existing) return existing;
  const pool = createPool(conn, { applicationName: `whereismybus-app-${ref}` });
  dedicatedPools.set(ref, pool);
  return pool;
}

/** The pool serving a tenant. Shared tenants (default) use the app pool. */
export function getPool(tenant?: TenantRef | null): Pool {
  if (!tenant || !tenant.tenantMode || tenant.tenantMode === 'shared') return getAppPool();
  const ref = tenant.dbConnectionRef;
  const pool = ref ? dedicatedPools.get(ref) : undefined;
  if (!pool) {
    log.error({ dbConnectionRef: ref ?? null }, 'Dedicated tenant pool is not registered');
    throw serviceUnavailable('The school database is not available.');
  }
  return pool;
}

/** Ends every pool (graceful shutdown, tests). Safe to call repeatedly. */
export async function closePools(): Promise<void> {
  const pools = [appPool, ownerPool, ...dedicatedPools.values()].filter((p): p is Pool => p !== null);
  appPool = null;
  ownerPool = null;
  dedicatedPools.clear();
  await Promise.allSettled(pools.map((p) => p.end()));
}

/** Cheap connectivity probe (readiness): never throws. */
export async function ping(pool: Pool = getAppPool()): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = performance.now();
  try {
    await pool.query('select 1');
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { ok: false, latencyMs: Math.round(performance.now() - started), error: code ?? 'DB_UNAVAILABLE' };
  }
}

// ── row mapping (snake_case DB → camelCase DTO) ──────────────────────────────
const camelCache = new Map<string, string>();

/** 'service_date' → 'serviceDate'. */
export function toCamel(key: string): string {
  let out = camelCache.get(key);
  if (out === undefined) {
    out = key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
    camelCache.set(key, out);
  }
  return out;
}

/** Shallow copy of a row with camelCase keys. */
export function camelizeRow<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) out[toCamel(key)] = row[key];
  return out as T;
}

export function camelizeRows<T = Record<string, unknown>>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => camelizeRow<T>(r));
}
