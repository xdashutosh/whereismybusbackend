// Seed 00 · platform (contract §14): the super admin (PLATFORM_ADMIN_EMAIL, demo password, TOTP
// NOT enrolled → the first login forces enrolment) and every platform_settings default that is
// missing. Idempotent: existing rows (and passwords) are never changed. On a non-local database
// (only reachable with --force / ALLOW_REMOTE_DEV_DB) the super admin must also change the
// password at first sign-in, so the documented demo password never stays valid there.
import type { SeedContext } from '../seed.js';
import { PLATFORM_SETTING_DEFAULTS } from '../platformDefaults.js';

export const SUPER_ADMIN_NAME = 'Platform Administrator';

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, config, logger, passwordHash, remoteTarget } = ctx;
  // platform_users / platform_settings are super-admin-only under FORCE RLS.
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });

  const settings = await tx.query(
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

  const admin = await tx.query<{ id: string }>(
    `insert into platform_users (email, name, password_hash, must_change_password, totp_enabled)
     values ($1, $2, $3, $4, false)
     on conflict (email) do nothing
     returning id`,
    [config.platformAdminEmail, SUPER_ADMIN_NAME, passwordHash, remoteTarget],
  );

  await ctx.setContext({ schoolId: null, actorId: null, role: 'system' });
  logger.info(
    { settingsInserted: settings.rowCount ?? 0, superAdminCreated: (admin.rowCount ?? 0) > 0, email: config.platformAdminEmail },
    'Platform seed applied',
  );
}
