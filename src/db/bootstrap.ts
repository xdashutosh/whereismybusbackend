// Production bootstrap (docs/DEPLOY_VERCEL_RENDER.md): the minimum a fresh database needs before the
// first sign-in — every missing platform_settings default and the first Super Admin. No demo data.
//   npm run db:bootstrap            (Render runs it in preDeployCommand after migrate + db:setup-roles)
// Runs as the OWNER, in one transaction, after checking that every migration is applied.
// Idempotent and safe on every deploy:
//   • platform_settings: inserts missing keys only (existing values are never changed);
//   • Super Admin PLATFORM_ADMIN_EMAIL: created only when no platform user has that e-mail, with
//     PLATFORM_ADMIN_INITIAL_PASSWORD, must_change_password = true and TOTP not enrolled (the first
//     sign-in forces a new password and TOTP enrolment). An existing admin is never touched: not the
//     password, not TOTP, not the active flag.
//   • An UNCLAIMED placeholder Super Admin (the only platform user, still superadmin@example.com, password
//     change pending, TOTP not enrolled — i.e. bootstrapped before the real e-mail was known) is moved to
//     PLATFORM_ADMIN_EMAIL instead of creating a second Super Admin. It keeps its initial password, or
//     takes PLATFORM_ADMIN_INITIAL_PASSWORD when that is set.
//   • PLATFORM_ADMIN_INITIAL_PASSWORD is required only while no Super Admin exists at all. Once one
//     exists, a missing password (or a changed PLATFORM_ADMIN_EMAIL without a password) is a warning,
//     never a failed deploy. Remove the variable from Render after the first sign-in.
// Works with NODE_ENV=production (unlike the demo seeds). Secrets are never logged or printed.
import config, { type Config, type DbConnection } from '../config/index.js';
import { newPassword } from '../modules/auth/schemas.js';
import { hashPassword } from '../shared/crypto.js';
import { logger as rootLogger, type Logger } from '../shared/logger.js';
import { isMainModule } from './cli.js';
import { assertMigrationsApplied } from './migrate.js';
import { PLATFORM_SETTING_DEFAULTS } from './platformDefaults.js';
import { closePools, createPool, type Pool } from './pool.js';
import { SET_CONTEXT_SQL } from './tenant.js';
import { SUPER_ADMIN_NAME } from './seeds/00_platform.js';

/** Placeholder default of PLATFORM_ADMIN_EMAIL (env.ts); refused in production. */
export const PLACEHOLDER_ADMIN_EMAIL = 'superadmin@example.com';

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export interface BootstrapOptions {
  pool?: Pool;
  conn?: DbConnection | null;
  email?: string;
  initialPassword?: string | null;
  isProduction?: boolean;
  logger?: Logger;
}

export interface BootstrapResult {
  settingsInserted: number;
  superAdmin: 'created' | 'exists' | 'claimed' | 'skipped';
  warnings: string[];
}

/** Validates the initial password with the same rules as a password change (8–128, letter + digit). */
export function initialPasswordIssue(password: string): string | null {
  const r = newPassword.safeParse(password);
  return r.success ? null : `PLATFORM_ADMIN_INITIAL_PASSWORD is too weak: ${r.error.issues.map((i) => i.message).join('; ')}`;
}

export async function runBootstrap({
  pool,
  conn = config.db.owner,
  email = config.platformAdminEmail,
  initialPassword = config.platformAdminInitialPassword,
  isProduction = config.isProduction,
  logger = rootLogger.child({ module: 'bootstrap' }),
}: BootstrapOptions = {}): Promise<BootstrapResult> {
  if (!pool && !conn) throw new BootstrapError('Database is not configured: set DATABASE_URL or DB_HOST/DB_USER/DB_NAME (owner role).');
  if (isProduction && email.toLowerCase() === PLACEHOLDER_ADMIN_EMAIL) {
    throw new BootstrapError('PLATFORM_ADMIN_EMAIL is not set: set it to the e-mail of the first Super Admin.');
  }
  const p = pool ?? createPool(conn ?? null, { max: 1, applicationName: 'whereismybus-bootstrap' });
  const warnings: string[] = [];
  try {
    await assertMigrationsApplied({ pool: p });
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      // platform_users / platform_settings are super-admin-only under FORCE RLS (owner is not BYPASSRLS on Neon).
      await client.query(SET_CONTEXT_SQL, ['', '', 'super_admin']);
      const settings = await client.query(
        `insert into platform_settings (key, value, description, is_public)
         select k, v, d, p from unnest($1::text[], $2::jsonb[], $3::text[], $4::boolean[]) as s(k, v, d, p)
         on conflict (key) do nothing`,
        [
          PLATFORM_SETTING_DEFAULTS.map((s) => s.key),
          PLATFORM_SETTING_DEFAULTS.map((s) => JSON.stringify(s.value)),
          PLATFORM_SETTING_DEFAULTS.map((s) => s.description),
          PLATFORM_SETTING_DEFAULTS.map((s) => s.isPublic),
        ],
      );
      const counts = await client.query<{ same: number; total: number }>(
        'select count(*) filter (where email = $1::citext)::int as same, count(*)::int as total from platform_users',
        [email],
      );
      const { same, total } = counts.rows[0]!;
      let superAdmin: BootstrapResult['superAdmin'];
      // The single, never-used placeholder account takes the configured e-mail — and the configured initial
      // password when one is given (it has never completed a sign-in, so nothing of value is replaced).
      const claimable = same === 0 && total === 1 && email.toLowerCase() !== PLACEHOLDER_ADMIN_EMAIL;
      if (claimable && initialPassword) {
        const issue = initialPasswordIssue(initialPassword);
        if (issue) throw new BootstrapError(issue);
      }
      const claimHash = claimable && initialPassword ? await hashPassword(initialPassword) : null;
      const claimed = claimable
        ? await client.query(
          `update platform_users set email = $1, password_hash = coalesce($3, password_hash), updated_at = now()
            where email = $2::citext and must_change_password and not totp_enabled`,
          [email, PLACEHOLDER_ADMIN_EMAIL, claimHash],
        )
        : null;
      if (same > 0) {
        superAdmin = 'exists';
        if (initialPassword) warnings.push('PLATFORM_ADMIN_INITIAL_PASSWORD is still set but the Super Admin already exists (it is ignored): remove it from the environment.');
      } else if (claimed && (claimed.rowCount ?? 0) > 0) {
        superAdmin = 'claimed';
        if (initialPassword) warnings.push('The unused Super Admin now uses PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_INITIAL_PASSWORD: sign in, then remove PLATFORM_ADMIN_INITIAL_PASSWORD from the environment.');
      } else if (!initialPassword) {
        if (total === 0) {
          throw new BootstrapError(
            'No Super Admin exists yet: set PLATFORM_ADMIN_INITIAL_PASSWORD (8+ characters with a letter and a digit) for the first sign-in, then deploy again.',
          );
        }
        superAdmin = 'skipped';
        warnings.push('PLATFORM_ADMIN_EMAIL has no account yet and PLATFORM_ADMIN_INITIAL_PASSWORD is not set: no Super Admin was created (existing Super Admins are unchanged).');
      } else {
        const issue = initialPasswordIssue(initialPassword);
        if (issue) throw new BootstrapError(issue);
        const hash = await hashPassword(initialPassword);
        const ins = await client.query(
          `insert into platform_users (email, name, password_hash, must_change_password, totp_enabled)
           values ($1, $2, $3, true, false)
           on conflict (email) do nothing`,
          [email, SUPER_ADMIN_NAME, hash],
        );
        superAdmin = (ins.rowCount ?? 0) > 0 ? 'created' : 'exists';
      }
      await client.query('COMMIT');
      for (const w of warnings) logger.warn(w);
      logger.info({ settingsInserted: settings.rowCount ?? 0, superAdmin, email }, 'Platform bootstrap applied');
      return { settingsInserted: settings.rowCount ?? 0, superAdmin, warnings };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    if (!pool) await p.end();
  }
}

async function cli(cfg: Config = config): Promise<number> {
  const target = cfg.db.owner ? `${cfg.db.owner.database} (${cfg.db.owner.source})` : '(unconfigured)';
  console.log(`Bootstrapping ${target} …`);
  try {
    const r = await runBootstrap();
    const admin = { created: 'created (must change the password and enrol TOTP at first sign-in)', exists: 'already exists (unchanged)', claimed: 'took over the unused placeholder account (sign in with its initial password, then change it and enrol TOTP)', skipped: 'not created' }[r.superAdmin];
    console.log(`Platform settings added: ${r.settingsInserted}. Super Admin ${cfg.platformAdminEmail}: ${admin}.`);
    for (const w of r.warnings) console.log(`Warning: ${w}`);
    return 0;
  } catch (err) {
    console.error(`Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await closePools().catch(() => undefined);
  }
}

if (isMainModule(import.meta.url)) {
  void cli().then((code) => {
    process.exitCode = code;
  });
}
