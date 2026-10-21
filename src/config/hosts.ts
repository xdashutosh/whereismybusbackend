// Database host classification shared by the reset guard (db/reset.ts) and the serve-mode guard
// (config/serveGuard.ts). Pure functions.
import type { DbConnection } from './db.js';

export const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Host name of a connection descriptor; '' when unknown. */
export function dbHost(conn: Pick<DbConnection, 'connectionString' | 'host'> | null | undefined): string {
  if (!conn) return '';
  if (conn.connectionString) {
    try {
      return new URL(conn.connectionString).hostname;
    } catch {
      return '';
    }
  }
  return conn.host ?? '';
}

/** True when the database runs on this machine. */
export function isLocalDatabase(conn: Pick<DbConnection, 'connectionString' | 'host'> | null | undefined): boolean {
  return LOCAL_HOSTS.has(dbHost(conn).toLowerCase());
}
