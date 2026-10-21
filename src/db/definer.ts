// Single-statement calls of the core schema's SECURITY DEFINER functions (contract §4, README §5).
//
// Pre-authentication lookups (login, refresh, session loading, OTP) and a few context-free helpers
// (parent_children_index for X-School-Id validation) run BEFORE any tenant is known. They are one
// statement each, so instead of a withTenant transaction they make one round trip on the shared app
// pool through this helper — the functions scope their own results (minimal columns, role guards).
// This is the ONLY place outside src/db that may run SQL without a tenant context; repositories and
// services call definerQuery() instead of importing a pool (contract §4 / BP §7.1: repositories
// never import a global pool). Only `select … from <function>(…)` statements are accepted.
// A missing function (42883: migrations not applied) becomes 503 SERVICE_UNAVAILABLE.
import { serviceUnavailable } from '../shared/errors.js';
import { logger as rootLogger } from '../shared/logger.js';
import { getAppPool, isPgError, PG_ERROR, type QueryResultRow } from './pool.js';

const log = rootLogger.child({ module: 'db.definer' });

/** `select <columns> from <function>(` — a call of one set-returning/scalar function. */
const DEFINER_CALL_RE = /^\s*select\s[\s\S]*?\bfrom\s+([a-z_][a-z0-9_]*)\s*\(/i;

export interface DefinerQueryOptions {
  /** Message of the 503 returned when the function does not exist yet. */
  unavailableMessage?: string;
}

/** Runs one SECURITY DEFINER function call on the app pool (no tenant context) → rows. */
export async function definerQuery<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = [], opts: DefinerQueryOptions = {}): Promise<R[]> {
  const fn = DEFINER_CALL_RE.exec(sql)?.[1];
  if (!fn) throw new TypeError('definerQuery only runs "select … from <function>(…)" statements');
  try {
    return (await getAppPool().query<R>(sql, params)).rows;
  } catch (err) {
    if (isPgError(err, PG_ERROR.UNDEFINED_FUNCTION)) {
      log.error({ fn }, 'SECURITY DEFINER function is not defined: apply the core schema migrations');
      throw serviceUnavailable(opts.unavailableMessage);
    }
    throw err;
  }
}
