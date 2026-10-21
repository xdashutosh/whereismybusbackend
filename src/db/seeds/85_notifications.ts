// Seed 85 · announcement inbox (contract §9 parent in-app inbox, BP §20 #6): the announcements seed 20 created
// that are live today (published, not expired, not withdrawn) are delivered the way the announcement engine
// records a delivery — one parent inbox entry per active linked parent for audiences 'parents' / 'all' and
// the audited 'announcement.deliver' marker listing the delivered segments — so the parent app's inbox is
// not empty on a fresh database and the per-minute announcement-sweep never re-sends them. No push is sent
// (seeding is historical data). The scheduled PTM notice stays undelivered: the sweep delivers it once due.
// Every query is scoped to the school explicitly: seed sessions (owner + actor_role 'system') pass the
// definer_access policy and would otherwise see every school's rows.
// Idempotent: segments already covered by a marker are skipped, and inbox inserts skip existing entries.
import * as repo from '../../modules/notifications/announcementRepository.js';
import { announcementLink } from '../../modules/notifications/announcements.js';
import { renderAnnouncement } from '../../modules/notifications/templates.js';
import { audit } from '../../shared/audit.js';
import type { SeedContext } from '../seed.js';
import { DEMO_ROUTES } from './50_routes.js';

interface LiveAnnouncement extends repo.DeliverableRow {
  school_id: string;
}

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger } = ctx;
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });
  const schools = await tx.many<{ id: string; code: string }>(
    'select id, code from schools where code = any ($1) and deleted_at is null order by code',
    [DEMO_ROUTES.map((s) => s.code)],
  );
  const summary: Record<string, { announcements: number; inbox: number }> = {};
  for (const school of schools) {
    const schoolCtx = { schoolId: school.id, actorId: null, role: 'system' as const };
    await ctx.setContext(schoolCtx);
    const stx = { ...tx, ctx: Object.freeze(schoolCtx) };
    const live = await stx.many<LiveAnnouncement>(
      `select a.id, a.school_id, a.title, a.body, a.audience, a.published_at, a.expires_at,
              false as deleted, true as due, false as expired
         from announcements a
        where a.school_id = $1 and a.deleted_at is null and a.published_at <= now() and (a.expires_at is null or a.expires_at > now())
        order by a.published_at`,
      [school.id],
    );
    const parents = await repo.schoolParents(stx);
    let announcements = 0;
    let inbox = 0;
    for (const a of live) {
      const done = await repo.deliveredSegments(stx, a.id);
      const segments = (['parents', 'drivers'] as const).filter(
        (seg) => !done.has(seg) && (a.audience === 'all' || a.audience === seg),
      );
      if (!segments.length) continue;
      let entries = 0;
      if (segments.includes('parents')) {
        const text = renderAnnouncement('en', a).inbox;
        entries = (
          await repo.insertAnnouncementInbox(stx, a.id, parents.map((p) => p.parent_account_id), {
            title: text.title,
            body: text.body,
            data: { ...announcementLink(school.id, a.id) },
          })
        ).length;
      }
      await audit.log(stx, {
        action: repo.DELIVER_ACTION,
        entityType: 'announcement',
        entityId: a.id,
        actorName: 'seed',
        new: { audience: a.audience, segments, parents: entries, drivers: segments.includes('drivers'), push: 'seed' },
      });
      announcements += 1;
      inbox += entries;
    }
    summary[school.code] = { announcements, inbox };
  }
  logger.info({ summary }, 'Announcement inbox seed applied');
}
