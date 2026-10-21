// Seeds 80_alerts and 85_notifications: the real scan engines raise the document alerts of the demo fleet
// and staff (visible in GET /school/alerts), live announcements land once in the parents' inbox with the
// per-segment delivery markers (the sweep and the deliver job never re-send them), and both seeds are
// idempotent.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { DEMO_PARENT } from '../src/db/seeds/01_demo_tenants.js';
import { deliverAnnouncement, sweepAnnouncements } from '../src/modules/notifications/announcements.js';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';

let t: TestApp;
const password = config.seedDefaultPassword ?? DEMO_PASSWORD;
const COUNTS = `select (select count(*)::int from alerts) as alerts,
                       (select count(*)::int from parent_notifications) as inbox,
                       (select count(*)::int from audit_logs where action in ('alert.scan', 'announcement.deliver')) as markers`;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  for (const only of ['00_', '01_', '10_', '20_', '30_', '40_', '50_', '60_']) await runSeeds({ only });
});
afterAll(closeDb);

describe('80_alerts seed', () => {
  it('raises the document alerts the daily scan would raise, idempotently, and admins see them in the inbox', async () => {
    expect((await runSeeds({ only: '80_' })).ran).toEqual(['80_alerts.ts']);
    const first = (await ownerQuery(COUNTS)).rows[0]!;
    await runSeeds({ only: '80_' });
    expect((await ownerQuery(COUNTS)).rows[0]).toEqual(first);
    const { rows } = await ownerQuery<{ type: string; code: string }>(
      `select a.alert_type as type, b.code from alerts a join schools s on s.id = a.school_id and s.code = 'GWIS-BLR'
         left join buses b on b.id = a.bus_id where a.status = 'open' order by 1, 2`,
    );
    // Seed 30: R3 fitness and R6 pollution expired, R2 insurance and R4 pollution expire within 30 days.
    expect(rows.filter((r) => r.type === 'doc_expired').map((r) => r.code)).toEqual(expect.arrayContaining(['R3', 'R6']));
    expect(rows.filter((r) => r.type === 'doc_expiring').map((r) => r.code)).toEqual(expect.arrayContaining(['R2', 'R4']));
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: 'admin@greenwood.example', password });
    expect(login.status).toBe(200);
    const list = await request(t.app)
      .get('/api/v1/school/alerts?type=doc_expired,doc_expiring&limit=100')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(rows.filter((r) => r.type === 'doc_expired' || r.type === 'doc_expiring').length);
    expect(list.body.meta.counts.open).toBeGreaterThan(0);
  });
});

describe('85_notifications seed', () => {
  it('delivers live announcements once into the parents\' inbox (both schools for the two-school parent)', async () => {
    expect((await runSeeds({ only: '85_' })).ran).toEqual(['85_notifications.ts']);
    const first = (await ownerQuery(COUNTS)).rows[0]!;
    await runSeeds({ only: '85_' });
    expect((await ownerQuery(COUNTS)).rows[0]).toEqual(first);
    const { rows } = await ownerQuery<{ title: string; code: string }>(
      `select pn.title, s.code from parent_notifications pn
         join parent_accounts pa on pa.id = pn.parent_account_id and pa.phone = $1
         join schools s on s.id = pn.school_id
        where pn.kind = 'announcement' order by s.code`,
      [DEMO_PARENT.phone],
    );
    // Only the live parent notice: the drivers notice, the scheduled PTM and the expired one are not in the inbox.
    expect(rows).toEqual([
      { title: 'Live bus tracking is now available', code: 'GWIS-BLR' },
      { title: 'Live bus tracking is now available', code: 'SUNRISE-JPR' },
    ]);
    // The sweep and an explicit deliver find nothing left for the seeded live announcements.
    expect((await sweepAnnouncements()).delivered).toBe(0);
    const live = await ownerQuery<{ id: string; school_id: string }>(
      `select id, school_id from announcements where published_at <= now() and (expires_at is null or expires_at > now())`,
    );
    expect(live.rows.length).toBeGreaterThan(0);
    for (const a of live.rows) expect((await deliverAnnouncement(a.school_id, a.id)).skipped).toBe('ALREADY_DELIVERED');
    expect((await ownerQuery(COUNTS)).rows[0]).toEqual(first);
  });
});
