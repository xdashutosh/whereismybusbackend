// Database connection descriptors (contract §3). Two roles per database:
//   owner — DATABASE_URL | DB_HOST/DB_USER/DB_PASSWORD/DB_NAME: migrations, seeds, setup-roles
//   app   — DATABASE_APP_URL | the owner location with DB_APP_USER/DB_APP_PASSWORD: runtime
// Test equivalents: TEST_DATABASE_URL | DB_* + TEST_DB_NAME, TEST_DATABASE_APP_URL | derived.
// A connection string carries its own TLS settings (sslmode=…); DB_SSL applies to DB_* only.
import type { RawEnv } from './env.js';

export interface DbConnection {
  /** Where the descriptor came from, e.g. 'DATABASE_URL' or 'DB_* + DB_APP_USER' (no secrets). */
  readonly source: string;
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly user: string | null;
  readonly password?: string;
  readonly database: string;
  readonly ssl: false | { rejectUnauthorized: boolean } | undefined;
  readonly max: number;
}

export interface DbPair {
  readonly owner: DbConnection | null;
  readonly app: DbConnection | null;
  /** True when no app credentials exist and runtime falls back to the owner (development only). */
  readonly appIsOwnerFallback: boolean;
}

export function databaseNameFromUrl(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || null;
  } catch {
    return null;
  }
}

export function userFromUrl(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).username) || null;
  } catch {
    return null;
  }
}

export function replaceDatabaseInUrl(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(dbName)}`;
  return u.toString();
}

export function replaceCredentialsInUrl(url: string, user: string, password: string | undefined): string {
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.password = password ? encodeURIComponent(password) : '';
  return u.toString();
}

function fromUrl(url: string, source: string, max: number, issues: string[], label: string): DbConnection | null {
  const database = databaseNameFromUrl(url);
  if (!database) {
    issues.push(`${label}: connection string must be a valid URL naming a database`);
    return null;
  }
  return { source, connectionString: url, user: userFromUrl(url), database, ssl: undefined, max };
}

function fromParts(
  e: RawEnv,
  { user, password, database, source }: { user: string; password: string | undefined; database: string; source: string },
): DbConnection {
  return {
    source,
    host: e.DB_HOST,
    port: e.DB_PORT,
    user,
    password,
    database,
    ssl: e.DB_SSL ? { rejectUnauthorized: e.DB_SSL_REJECT_UNAUTHORIZED } : false,
    max: e.DB_POOL_MAX,
  };
}

/** Owner + app descriptors for the main (test = false) or test database. */
export function buildDbPair(e: RawEnv, { test, isProduction }: { test: boolean; isProduction: boolean }, issues: string[]): DbPair {
  const label = test ? 'test database' : 'database';
  // ── owner ──
  let owner: DbConnection | null = null;
  let ownerUrl = test ? e.TEST_DATABASE_URL : e.DATABASE_URL;
  let ownerSource = test ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  if (!ownerUrl && test && e.DATABASE_URL && e.TEST_DB_NAME) {
    ownerUrl = replaceDatabaseInUrl(e.DATABASE_URL, e.TEST_DB_NAME);
    ownerSource = 'DATABASE_URL + TEST_DB_NAME';
  }
  if (ownerUrl) {
    owner = fromUrl(ownerUrl, ownerSource, e.DB_POOL_MAX, issues, label);
  } else {
    const dbName = test ? e.TEST_DB_NAME : e.DB_NAME;
    if (e.DB_HOST && e.DB_USER && dbName) {
      owner = fromParts(e, { user: e.DB_USER, password: e.DB_PASSWORD, database: dbName, source: test ? 'DB_* + TEST_DB_NAME' : 'DB_*' });
    }
  }

  // ── app ──
  let app: DbConnection | null = null;
  const appUrl = test ? e.TEST_DATABASE_APP_URL : e.DATABASE_APP_URL;
  if (appUrl) {
    app = fromUrl(appUrl, test ? 'TEST_DATABASE_APP_URL' : 'DATABASE_APP_URL', e.DB_POOL_MAX, issues, `${label} (app role)`);
  } else if (owner && e.DB_APP_USER) {
    if (owner.connectionString) {
      app = {
        ...owner,
        source: `${owner.source} + DB_APP_USER`,
        connectionString: replaceCredentialsInUrl(owner.connectionString, e.DB_APP_USER, e.DB_APP_PASSWORD),
        user: e.DB_APP_USER,
      };
    } else {
      app = fromParts(e, { user: e.DB_APP_USER, password: e.DB_APP_PASSWORD, database: owner.database, source: `${owner.source} + DB_APP_USER` });
    }
  }
  if (app && owner && app.database !== owner.database) {
    issues.push(`${label}: the app connection must target the same database as the owner connection`);
  }

  let appIsOwnerFallback = false;
  if (!app && owner) {
    if (isProduction) {
      issues.push('production requires the RLS-restricted app role: set DATABASE_APP_URL or DB_APP_USER/DB_APP_PASSWORD');
    } else if (!test) {
      app = { ...owner, source: `${owner.source} (owner fallback)` };
      appIsOwnerFallback = true;
    }
  }
  if (isProduction && app && owner && !appIsOwnerFallback && app.user && owner.user && app.user === owner.user) {
    issues.push('the app role must differ from the owner role (DB_APP_USER = DB_USER bypasses RLS ownership rules)');
  }
  if (app?.user && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(app.user)) {
    issues.push('DB_APP_USER must be a plain identifier (letters, digits, underscore)');
  }
  return { owner, app, appIsOwnerFallback };
}
