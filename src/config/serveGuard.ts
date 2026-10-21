// Serve-mode guard (fail safe). Outside production the API relaxes protections on purpose (500
// responses carry the raw error message, CORS may allow every origin, local storage and an
// ephemeral JWT secret are accepted). Those relaxations are only safe on a developer's own
// database, so a non-production API/worker refuses to boot against a remote database (e.g. the
// production credentials in backend/.env when backend/.env.local is missing) unless the operator
// opts in with ALLOW_REMOTE_DEV_DB=true. Migrations, seeds and tests are not affected.
import type { Config } from './index.js';
import { dbHost, isLocalDatabase } from './hosts.js';

/** null when the process may serve in this mode, otherwise the reason (no secrets, no host). */
export function serveModeIssue(cfg: Pick<Config, 'isProduction' | 'isTest' | 'env' | 'db' | 'allowRemoteDevDb'>): string | null {
  if (cfg.isProduction || cfg.isTest) return null;
  const conn = cfg.db.app ?? cfg.db.owner;
  if (!conn || isLocalDatabase(conn) || cfg.allowRemoteDevDb) return null;
  const known = dbHost(conn) ? 'a remote database host' : 'a database whose host cannot be determined';
  return (
    `NODE_ENV=${cfg.env} with ${known}: development mode exposes raw error messages and relaxed CORS. ` +
    'Run with NODE_ENV=production (npm start), point DATABASE_URL/DATABASE_APP_URL at a local database (backend/.env.local), ' +
    'or set ALLOW_REMOTE_DEV_DB=true to accept the risk deliberately.'
  );
}
