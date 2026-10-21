// Scenario suite — daily trip generation (BP §7.3, §10.1, §19 #10): schedule edits during the day,
// holidays added/removed after the 00:05 run, timezones and the school-cron dispatcher after a restart.
// Each test asserts the blueprint behaviour (moved from the pre-release scenario run into the default suite).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSchoolCronDispatcher, pgCursorStore } from '../../src/jobs/schoolCron.js';
import { JOB_DEFINITIONS } from '../../src/jobs/index.js';
import type { SchoolCronJobDef } from '../../src/jobs/types.js';
import { createMemoryKv } from '../../src/shared/kv.js';
import { generateDailyTrips, tripNotStartedCheck } from '../../src/modules/trips/jobs.js';
import { closeDb, ownerQuery, truncateAll } from '../helpers/db.js';
import * as f from '../helpers/factories.js';
import { buildApp, type TestApp } from '../helpers/authApp.js';
import { asAdmin, localDate, tripWorld, type TripWorld } from '../trips.fixtures.js';
import request from 'supertest';

let t: TestApp;
beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);

const todaysTrips = async (scheduleId: string, day: string) =>
  (await ownerQuery<{ id: string; status: string; cancel_reason: string | null }>('select id, status, cancel_reason from trips where schedule_id = $1 and trip_date = $2', [scheduleId, day])).rows;

const patch = (w: TripWorld, path: string, body: object) => request(w.t.app).patch(`/api/v1${path}`).set({ Authorization: `Bearer ${w.adminToken}` }).send(body);
const del = (w: TripWorld, path: string) => request(w.t.app).delete(`/api/v1${path}`).set({ Authorization: `Bearer ${w.adminToken}` });
/** HH:mm two hours from now, school-local (stays today unless the run is within 2 h of midnight). */
async function laterToday(): Promise<string> {
  const { rows } = await ownerQuery<{ hm: string }>("select to_char((now() at time zone 'Asia/Kolkata') + interval '2 hours', 'HH24:MI') as hm");
  return rows[0]!.hm;
}

describe('schedule changes during the day', () => {
  it('a schedule deactivated by mistake and re-activated the same day gets its trip back', async () => {
    const w = await tripWorld(t);
    const off = await patch(w, `/school/trip-schedules/${w.schedule.id}`, { isActive: false });
    expect(off.status).toBe(200);
    expect((await todaysTrips(w.schedule.id, w.today))[0]!.status).toBe('cancelled');
    const on = await patch(w, `/school/trip-schedules/${w.schedule.id}`, { isActive: true });
    expect(on.status).toBe(200);
    await generateDailyTrips({ schoolId: w.sid, localDate: w.today }); // a later 00:05 run would not help either
    const rows = await todaysTrips(w.schedule.id, w.today);
    // Expected: today's trip is startable again (scheduled). Actual: stays cancelled forever (UNIQUE schedule_id, trip_date).
    expect(rows.map((r) => r.status)).toContain('scheduled');
  });

  it('a weekday removed and re-added the same day gets its trip back', async () => {
    const w = await tripWorld(t);
    const dow = Number((await ownerQuery<{ d: number }>('select extract(isodow from $1::date)::int as d', [w.today])).rows[0]!.d);
    const others = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== dow);
    expect((await patch(w, `/school/trip-schedules/${w.schedule.id}`, { daysOfWeek: others })).status).toBe(200);
    expect((await todaysTrips(w.schedule.id, w.today))[0]!.status).toBe('cancelled');
    expect((await patch(w, `/school/trip-schedules/${w.schedule.id}`, { daysOfWeek: [1, 2, 3, 4, 5, 6, 7] })).status).toBe(200);
    await generateDailyTrips({ schoolId: w.sid, localDate: w.today });
    expect((await todaysTrips(w.schedule.id, w.today)).map((r) => r.status)).toContain('scheduled');
  });

  it('a schedule created mid-day for a run later today produces a startable trip today', async () => {
    const w = await tripWorld(t);
    const bus2 = await f.bus(w.sid, { code: 'R2' });
    await f.busStaffAssignment(w.sid, bus2.id, w.backup.staff.id, { assignment_role: 'primary_driver', valid_from: new Date(Date.now() - 86_400_000).toISOString() });
    const res = await asAdmin(w.t, w.adminToken).post('/school/trip-schedules', { busId: bus2.id, routeId: w.route.id, plannedStartTime: await laterToday(), daysOfWeek: [1, 2, 3, 4, 5, 6, 7] });
    expect(res.status).toBe(201);
    // Expected: today's trip exists (or is created on demand) so the driver can start it today.
    expect((await todaysTrips(res.body.data.id, w.today)).length).toBe(1);
  });

  it('a holiday entered for today by mistake and deleted again restores today’s trips', async () => {
    const w = await tripWorld(t);
    const h = await asAdmin(w.t, w.adminToken).post('/school/holidays', { name: 'Rain day', startDate: w.today, appliesTo: 'all' });
    expect(h.status).toBe(201);
    await tripNotStartedCheck({ schoolId: w.sid }); // every minute: cancels today's scheduled trips
    expect((await todaysTrips(w.schedule.id, w.today))[0]!.status).toBe('cancelled');
    expect((await del(w, `/school/holidays/${h.body.data.id}`)).status).toBeLessThan(300);
    await tripNotStartedCheck({ schoolId: w.sid });
    await generateDailyTrips({ schoolId: w.sid, localDate: w.today });
    expect((await todaysTrips(w.schedule.id, w.today)).map((r) => r.status)).toContain('scheduled');
  });
});

describe('only what a schedule change cancelled comes back', () => {
  it('a trip the admin cancelled by hand stays cancelled when its schedule is re-activated', async () => {
    const w = await tripWorld(t);
    const c = await asAdmin(w.t, w.adminToken).post(`/school/trips/${w.trip.id}/cancel`, { reason: 'Driver on leave' });
    expect(c.status).toBe(200);
    expect((await patch(w, `/school/trip-schedules/${w.schedule.id}`, { isActive: false })).status).toBe(200);
    expect((await patch(w, `/school/trip-schedules/${w.schedule.id}`, { isActive: true })).status).toBe(200);
    expect(await todaysTrips(w.schedule.id, w.today)).toEqual([{ id: w.trip.id, status: 'cancelled', cancel_reason: 'Driver on leave' }]);
  });

  it('a schedule created for a run that is already overdue today gets no trip today', async () => {
    const w = await tripWorld(t);
    const bus2 = await f.bus(w.sid, { code: 'R2' });
    const { rows } = await ownerQuery<{ hm: string }>("select to_char((now() at time zone 'Asia/Kolkata') - interval '2 hours', 'HH24:MI') as hm");
    const res = await asAdmin(w.t, w.adminToken).post('/school/trip-schedules', { busId: bus2.id, routeId: w.route.id, plannedStartTime: rows[0]!.hm, daysOfWeek: [1, 2, 3, 4, 5, 6, 7] });
    expect(res.status).toBe(201);
    // (Unless the run is within 2 h after midnight, "2 hours ago" is today and overdue: no trip, no alert.)
    const day = (await ownerQuery<{ d: string }>("select to_char((now() at time zone 'Asia/Kolkata') - interval '2 hours', 'YYYY-MM-DD') as d")).rows[0]!.d;
    if (day === w.today) expect(await todaysTrips(res.body.data.id, w.today)).toEqual([]);
  });
});

describe('timezones', () => {
  it('stores planned_start_at in the school timezone and marks missed per school-local date', async () => {
    for (const tz of ['Pacific/Honolulu', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
      const s = await f.school({ timezone: tz });
      const bus = await f.bus(s.id, { code: 'R1' });
      const route = await f.route(s.id, { code: 'R1', direction: 'morning' });
      const sch = await f.tripSchedule(s.id, bus.id, route.id, { planned_start_time: '23:50:00', days_of_week: [1, 2, 3, 4, 5, 6, 7] });
      const day = await localDate(tz);
      await generateDailyTrips({ schoolId: s.id, localDate: day });
      const { rows } = await ownerQuery<{ local: string; status: string }>(
        `select to_char(planned_start_at at time zone $2, 'YYYY-MM-DD HH24:MI') as local, status from trips where schedule_id = $1`, [sch.id, tz]);
      expect(rows).toEqual([{ local: `${day} 23:50`, status: 'scheduled' }]);
      await tripNotStartedCheck({ schoolId: s.id });
      const after = (await ownerQuery<{ status: string }>('select status from trips where schedule_id = $1', [sch.id])).rows[0]!.status;
      expect(after).toBe('scheduled'); // planned 23:50 local today — must not be missed early in another zone
    }
  });
});

describe('school-cron dispatcher after a restart (no Redis: in-memory KV)', () => {
  it('still runs generate-daily-trips when the process was down at 00:05 school-local', async () => {
    const enqueued: string[] = [];
    const defs = JOB_DEFINITIONS.filter((d): d is SchoolCronJobDef => d.kind === 'school-cron');
    // The new process starts at 00:12 IST (06:42 UTC previous day) — e.g. a Render deploy/restart at 00:04–00:11.
    const now = new Date('2026-10-19T18:42:00.000Z');
    const d = createSchoolCronDispatcher({
      defs,
      loadSchools: async () => [{ schoolId: '00000000-0000-0000-0000-000000000001', timezone: 'Asia/Kolkata' }],
      enqueue: async (name) => void enqueued.push(name),
      now: () => now,
      store: createMemoryKv(),
    });
    await d.handler({ scheduledAt: now.toISOString(), logger: { warn() {}, debug() {}, info() {}, error() {} } } as never);
    // Expected: today's generation is caught up (it is idempotent). Actual: only every-minute jobs run.
    expect(enqueued).toContain('generate-daily-trips');
  });

  it('keeps the cursor in Postgres: a restarted process resumes from the last dispatched minute', async () => {
    const defs = JOB_DEFINITIONS.filter((d): d is SchoolCronJobDef => d.kind === 'school-cron');
    const cursor = pgCursorStore(createMemoryKv(), `scn-restart-${Date.now()}`);
    const schools = async () => [{ schoolId: '00000000-0000-0000-0000-000000000001', timezone: 'Asia/Kolkata' }];
    const ctx = (at: Date) => ({ scheduledAt: at.toISOString(), logger: { warn() {}, debug() {}, info() {}, error() {} } }) as never;
    const run = async (at: Date) => {
      const enqueued: string[] = [];
      // A new dispatcher instance each time = a new process (nothing kept in memory).
      const d = createSchoolCronDispatcher({ defs, loadSchools: schools, enqueue: async (name) => void enqueued.push(name), now: () => at, cursor });
      await d.handler(ctx(at));
      return enqueued;
    };
    // 00:03 IST, 23 Oct (a full window first: no cursor yet), then the process is down 00:04–00:11.
    await run(new Date('2026-10-22T18:33:00.000Z'));
    const afterRestart = await run(new Date('2026-10-22T18:42:00.000Z'));
    expect(afterRestart).toContain('generate-daily-trips');
    expect(afterRestart).not.toContain('alert-email-digest'); // 07:00 local was not in (00:03, 00:12]
    // The next minute does not dispatch the generation again.
    expect(await run(new Date('2026-10-22T18:43:00.000Z'))).not.toContain('generate-daily-trips');
  });
});
