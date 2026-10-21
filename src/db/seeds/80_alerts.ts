// Seed 80 · scan alerts (contract §14, BP §11.1): runs the REAL daily scan jobs — documentExpiryScan and
// maintenanceDueScan, exactly what the 06:30 / 06:45 school-local jobs do — once per demo school, so the admin
// alert inbox and bell show the expiring / expired bus and staff documents and the missing licences that
// seeds 30 and 40 created. The scans write one 'alert.scan' audit row when they change anything.
//
// The scans run on the APP pool inside withSchoolSystem (one school per transaction, RLS enforced), not on
// the seed's owner transaction: seed sessions use actor_role 'system', which passes the owner-only
// definer_access policy (every school's rows), and the scan engine relies on RLS for its school scope. When
// the app connection is not RLS-restricted (development fallback to the owner), the seed is skipped with a
// warning — run `npm run db:setup-roles` and set DATABASE_APP_URL / DB_APP_*.
// Idempotent: the reconcile engine raises only alerts that do not exist yet (dedupe keys), so a second run
// inserts nothing.
import { documentExpiryScan, maintenanceDueScan } from '../../modules/alerts/jobs.js';
import { getAppPool } from '../pool.js';
import type { SeedContext } from '../seed.js';
import { DEMO_ROUTES } from './50_routes.js';

/** Is the app connection a role that bypasses RLS (superuser / BYPASSRLS)? */
async function appRoleBypassesRls(): Promise<boolean> {
  const { rows } = await getAppPool().query<{ bypass: boolean }>(
    'select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user',
  );
  return rows[0]?.bypass ?? true;
}

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger } = ctx;
  if (!ctx.config.db.app || (await appRoleBypassesRls())) {
    logger.warn('Scan alerts seed skipped: the app database role is not configured or bypasses RLS (run npm run db:setup-roles and set DATABASE_APP_URL)');
    return;
  }
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });
  const schools = await tx.many<{ id: string; code: string }>(
    'select id, code from schools where code = any ($1) and deleted_at is null order by code',
    [DEMO_ROUTES.map((s) => s.code)],
  );
  const summary: Record<string, { localDate: string; raised: number; desired: number }> = {};
  for (const school of schools) {
    const docs = await documentExpiryScan({ schoolId: school.id });
    const due = await maintenanceDueScan({ schoolId: school.id });
    summary[school.code] = { localDate: docs.localDate, raised: docs.raised + due.raised, desired: docs.desired + due.desired };
  }
  logger.info({ summary }, 'Scan alerts seed applied');
}
