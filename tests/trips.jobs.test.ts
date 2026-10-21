// Trip jobs (BP §7.3, contract §8): generate-daily-trips (idempotent, weekdays, validity, holidays,
// inactive schedules/buses/routes, local planned start, staff snapshots), trip-not-started-check
// (grace, alert once, parent event, holiday cancellation, missed) and stale-trip-closer (auto_closed +
// alert), each confined to its own school.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_DEFINITIONS } from '../src/jobs/index.js';
import { events, type AppEvents } from '../src/shared/events.js';
import { generateDailyTrips, staleTripCloser, tripNotStartedCheck } from '../src/modules/trips/jobs.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { localDate } from './trips.fixtures.js';

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
});
afterAll(closeDb);

const isoDow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
const tick = () => new Promise((r) => setTimeout(r, 5));

async function fleet(timezone = 'Asia/Kolkata') {
  const s = await f.school({ timezone });
  const driver = await f.staffProfile(s.id, { full_name: 'Ramesh Kumar' });
  const conductor = await f.staffProfile(s.id, { staff_type: 'conductor', full_name: 'Suresh Babu' });
  const bus = await f.bus(s.id, { code: 'R1' });
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  await f.busStaffAssignment(s.id, bus.id, driver.id, { assignment_role: 'primary_driver', valid_from: since });
  await f.busStaffAssignment(s.id, bus.id, conductor.id, { assignment_role: 'conductor', valid_from: since });
  const am = await f.route(s.id, { code: 'R1', name: 'Route 1', direction: 'morning' });
  const pm = await f.route(s.id, { code: 'R1', name: 'Route 1 PM', direction: 'afternoon' });
  return { s, sid: s.id, driver, conductor, bus, am, pm };
}

describe('job registration', () => {
  it('registers the three trip jobs as school-local cron jobs', () => {
    const byName = new Map(JOB_DEFINITIONS.map((d) => [d.name, d]));
    expect(byName.get('generate-daily-trips')).toMatchObject({ kind: 'school-cron', cron: '5 0 * * *' });
    expect(byName.get('trip-not-started-check')).toMatchObject({ kind: 'school-cron', cron: '* * * * *' });
    expect(byName.get('stale-trip-closer')).toMatchObject({ kind: 'school-cron', cron: '*/5 * * * *' });
  });
});

describe('generate-daily-trips', () => {
  it('creates one scheduled trip per running schedule with snapshots and the local planned start; idempotent', async () => {
    const w = await fleet('Asia/Kolkata');
    const day = await localDate('Asia/Kolkata', 1);
    const dow = isoDow(day);
    const other = ((dow % 7) + 1);
    const morning = await f.tripSchedule(w.sid, w.bus.id, w.am.id, { planned_start_time: '07:00:00', days_of_week: [dow] });
    const afternoon = await f.tripSchedule(w.sid, w.bus.id, w.pm.id, { direction: 'afternoon', planned_start_time: '14:30:00', days_of_week: [dow, other] });
    await f.tripSchedule(w.sid, w.bus.id, w.am.id, { planned_start_time: '08:00:00', days_of_week: [other] }); // another weekday
    await f.tripSchedule(w.sid, w.bus.id, w.am.id, { planned_start_time: '09:00:00', days_of_week: [dow], is_active: false });
    await f.tripSchedule(w.sid, w.bus.id, w.am.id, { planned_start_time: '09:30:00', days_of_week: [dow], deleted_at: new Date().toISOString() });
    await f.tripSchedule(w.sid, w.bus.id, w.am.id, { planned_start_time: '10:00:00', days_of_week: [dow], valid_to: await localDate('Asia/Kolkata', 0) });
    await f.tripSchedule(w.sid, w.bus.id, w.am.id, { planned_start_time: '10:30:00', days_of_week: [dow], valid_from: await localDate('Asia/Kolkata', 2) });

    expect(await generateDailyTrips({ schoolId: w.sid, localDate: day })).toEqual({ created: 2 });
    const { rows } = await ownerQuery<Record<string, unknown>>(
      `select schedule_id, status, trip_type, direction, trip_date::text as trip_date, bus_code_snapshot, bus_registration_snapshot, route_code_snapshot, route_name_snapshot,
              driver_staff_id, driver_name_snapshot, conductor_staff_id, conductor_name_snapshot, planned_start_at
         from trips where school_id = $1 order by planned_start_at`,
      [w.sid],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      schedule_id: morning.id, status: 'scheduled', trip_type: 'school', direction: 'morning', trip_date: day, bus_code_snapshot: 'R1',
      route_code_snapshot: 'R1', route_name_snapshot: 'Route 1', driver_staff_id: w.driver.id, driver_name_snapshot: 'Ramesh Kumar',
      conductor_staff_id: w.conductor.id, conductor_name_snapshot: 'Suresh Babu', planned_start_at: `${day}T01:30:00.000Z`,
    });
    expect(rows[1]).toMatchObject({ schedule_id: afternoon.id, direction: 'afternoon', planned_start_at: `${day}T09:00:00.000Z` });
    expect(await generateDailyTrips({ schoolId: w.sid, localDate: day })).toEqual({ created: 0 });
    // A trip cancelled by the school is never re-created.
    await ownerQuery("update trips set status = 'cancelled' where schedule_id = $1", [morning.id]);
    expect(await generateDailyTrips({ schoolId: w.sid, localDate: day })).toEqual({ created: 0 });
    const audit = await ownerQuery("select count(*)::int as n from audit_logs where school_id = $1 and action = 'trip.generate'", [w.sid]);
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('uses the school timezone for the planned start', async () => {
    const w = await fleet('America/New_York');
    const day = '2026-07-15';
    await f.tripSchedule(w.sid, w.bus.id, w.am.id, { planned_start_time: '07:00:00', days_of_week: [isoDow(day)] });
    await generateDailyTrips({ schoolId: w.sid, localDate: day });
    const { rows } = await ownerQuery<{ planned_start_at: string }>('select planned_start_at from trips where school_id = $1', [w.sid]);
    expect(rows[0]!.planned_start_at).toBe('2026-07-15T11:00:00.000Z');
  });

  it('skips holidays (all day or the direction), inactive/maintenance buses and inactive routes', async () => {
    const w = await fleet();
    const day = await localDate('Asia/Kolkata', 3);
    const dow = isoDow(day);
    await f.tripSchedule(w.sid, w.bus.id, w.am.id, { days_of_week: [dow] });
    await f.tripSchedule(w.sid, w.bus.id, w.pm.id, { direction: 'afternoon', planned_start_time: '14:00:00', days_of_week: [dow] });
    const h = await f.schoolHoliday(w.sid, { name: 'Half day', start_date: day, end_date: day, applies_to: 'afternoon' });
    expect(await generateDailyTrips({ schoolId: w.sid, localDate: day })).toEqual({ created: 1 });
    await ownerQuery('delete from trips where school_id = $1', [w.sid]);
    await ownerQuery("update school_holidays set applies_to = 'all' where id = $1", [h.id]);
    expect(await generateDailyTrips({ schoolId: w.sid, localDate: day })).toEqual({ created: 0 });
    await ownerQuery('delete from school_holidays where id = $1', [h.id]);
    await ownerQuery("update buses set status = 'maintenance' where id = $1", [w.bus.id]);
    expect(await generateDailyTrips({ schoolId: w.sid, localDate: day })).toEqual({ created: 0 });
    await ownerQuery("update buses set status = 'active' where id = $1", [w.bus.id]);
    await ownerQuery('update routes set is_active = false where id = $1', [w.am.id]);
    expect(await generateDailyTrips({ schoolId: w.sid, localDate: day })).toEqual({ created: 1 });
  });

  it('works only on its own school', async () => {
    const a = await fleet();
    const b = await fleet();
    const day = await localDate('Asia/Kolkata', 4);
    await f.tripSchedule(a.sid, a.bus.id, a.am.id, { days_of_week: [isoDow(day)] });
    await f.tripSchedule(b.sid, b.bus.id, b.am.id, { days_of_week: [isoDow(day)] });
    await generateDailyTrips({ schoolId: a.sid, localDate: day });
    const { rows } = await ownerQuery<{ school_id: string }>('select school_id from trips where school_id in ($1, $2)', [a.sid, b.sid]);
    expect(rows.map((r) => r.school_id)).toEqual([a.sid]);
  });
});

describe('trip-not-started-check', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  async function scheduledTrip(w: Awaited<ReturnType<typeof fleet>>, plannedMinutesAgo: number, o: f.Values = {}) {
    return f.trip(w.sid, w.bus.id, { route_id: w.am.id, status: 'scheduled', trip_date: await localDate(), planned_start_at: minutesAgo(plannedMinutesAgo), bus_code_snapshot: 'R1', route_code_snapshot: 'R1', ...o });
  }

  it('alerts once after the grace period and emits trip.not_started for parent notifications', async () => {
    const w = await fleet();
    const late = await scheduledTrip(w, 15);
    const early = await scheduledTrip(w, 5);
    const seen: AppEvents['trip.not_started'][] = [];
    const off = events.on('trip.not_started', (p) => void seen.push(p));
    expect(await tripNotStartedCheck({ schoolId: w.sid })).toEqual({ alerted: 1, missed: 0, holidayCancelled: 0 });
    await tick();
    expect(seen).toEqual([expect.objectContaining({ schoolId: w.sid, tripId: late.id, busId: w.bus.id, direction: 'morning' })]);
    const alerts = await ownerQuery<{ trip_id: string; alert_type: string; severity: string; title: string }>("select trip_id, alert_type, severity, title from alerts where school_id = $1", [w.sid]);
    expect(alerts.rows).toEqual([{ trip_id: late.id, alert_type: 'trip_not_started', severity: 'warning', title: 'Bus R1 morning trip R1 has not started' }]);
    expect(await tripNotStartedCheck({ schoolId: w.sid })).toEqual({ alerted: 0, missed: 0, holidayCancelled: 0 });
    await ownerQuery("update alerts set status = 'closed' where school_id = $1", [w.sid]);
    expect((await tripNotStartedCheck({ schoolId: w.sid })).alerted).toBe(0);
    off();
    const row = await ownerQuery('select status from trips where id = $1', [early.id]);
    expect(row.rows[0]!.status).toBe('scheduled');
  });

  it('respects notify_trip_not_started and the grace setting', async () => {
    const w = await fleet();
    await f.schoolSettings(w.sid, { notify_trip_not_started: false, trip_not_started_grace_min: 30 });
    await scheduledTrip(w, 20);
    expect((await tripNotStartedCheck({ schoolId: w.sid })).alerted).toBe(0);
    await scheduledTrip(w, 40);
    const seen: unknown[] = [];
    const off = events.on('trip.not_started', (p) => void seen.push(p));
    expect((await tripNotStartedCheck({ schoolId: w.sid })).alerted).toBe(1);
    await tick();
    off();
    expect(seen).toEqual([]);
  });

  it('cancels trips that fall on a holiday added after generation (no alert)', async () => {
    const w = await fleet();
    const today = await localDate();
    const t1 = await scheduledTrip(w, 30);
    await f.schoolHoliday(w.sid, { name: 'Rain holiday', start_date: today, end_date: today });
    expect(await tripNotStartedCheck({ schoolId: w.sid })).toEqual({ alerted: 0, missed: 0, holidayCancelled: 1 });
    const row = await ownerQuery('select status, cancel_reason from trips where id = $1', [t1.id]);
    expect(row.rows[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'School holiday: Rain holiday' });
  });

  it('marks trips missed after the window (and those of earlier days)', async () => {
    const w = await fleet();
    const old = await scheduledTrip(w, 200);
    const yesterday = await f.trip(w.sid, w.bus.id, { status: 'scheduled', trip_date: await localDate('Asia/Kolkata', -1), planned_start_at: null });
    const fresh = await scheduledTrip(w, 60);
    const res = await tripNotStartedCheck({ schoolId: w.sid });
    expect(res.missed).toBe(2);
    const rows = await ownerQuery<{ id: string; status: string; close_reason: string | null }>('select id, status, close_reason from trips where school_id = $1', [w.sid]);
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(old.id)).toMatchObject({ status: 'missed', close_reason: 'Not started within 180 minutes of the planned start' });
    expect(byId.get(yesterday.id)!.status).toBe('missed');
    expect(byId.get(fresh.id)!.status).toBe('scheduled');
    const alerted = await ownerQuery<{ trip_id: string }>("select trip_id from alerts where school_id = $1 and alert_type = 'trip_not_started' order by trip_id", [w.sid]);
    expect(alerted.rows.map((r) => r.trip_id).sort()).toEqual([old.id, fresh.id].sort());
  });
});

describe('stale-trip-closer', () => {
  it('auto-closes trips without points for the configured hours and raises trip_auto_closed', async () => {
    const w = await fleet();
    await f.schoolSettings(w.sid, { stale_trip_close_hours: 2 });
    const stale = await f.activeTrip(w.sid, w.bus.id, { started_at: new Date(Date.now() - 5 * 3600_000).toISOString(), last_point_at: new Date(Date.now() - 3 * 3600_000).toISOString(), bus_code_snapshot: 'R1' });
    const bus2 = await f.bus(w.sid, { code: 'R2' });
    const silent = await f.activeTrip(w.sid, bus2.id, { started_at: new Date(Date.now() - 150 * 60_000).toISOString() });
    const bus3 = await f.bus(w.sid, { code: 'R3' });
    const fresh = await f.activeTrip(w.sid, bus3.id, { started_at: new Date(Date.now() - 5 * 3600_000).toISOString(), last_point_at: new Date(Date.now() - 30 * 60_000).toISOString() });
    await f.locationPoints(w.sid, stale.id, 3);
    const seen: AppEvents['trip.status_changed'][] = [];
    const off = events.on('trip.status_changed', (p) => void seen.push(p));
    expect(await staleTripCloser({ schoolId: w.sid })).toEqual({ closed: 2 });
    await tick();
    off();
    const rows = await ownerQuery<{ id: string; status: string; ended_at: string; last_point_at: string | null; started_at: string; close_reason: string | null; distance_gps_km: number | null }>(
      'select id, status, ended_at, last_point_at, started_at, close_reason, distance_gps_km from trips where school_id = $1',
      [w.sid],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(stale.id)).toMatchObject({ status: 'auto_closed', close_reason: 'No location data for 2 hours: closed automatically' });
    expect(byId.get(stale.id)!.ended_at).toBe(byId.get(stale.id)!.last_point_at);
    expect(byId.get(stale.id)!.distance_gps_km).not.toBeNull();
    expect(byId.get(silent.id)).toMatchObject({ status: 'auto_closed' });
    expect(byId.get(silent.id)!.ended_at).toBe(byId.get(silent.id)!.started_at);
    expect(byId.get(fresh.id)!.status).toBe('in_progress');
    const alerts = await ownerQuery<{ trip_id: string; alert_type: string }>("select trip_id, alert_type from alerts where school_id = $1 order by trip_id", [w.sid]);
    expect(alerts.rows.map((a) => a.alert_type)).toEqual(['trip_auto_closed', 'trip_auto_closed']);
    expect(seen.map((s) => s.status)).toEqual(['auto_closed', 'auto_closed']);
    expect(await staleTripCloser({ schoolId: w.sid })).toEqual({ closed: 0 });
    const audit = await ownerQuery("select count(*)::int as n from audit_logs where school_id = $1 and action = 'trip.auto_close'", [w.sid]);
    expect(audit.rows[0]!.n).toBe(2);
  });

  it('falls back to the platform default stale hours and never touches another school', async () => {
    const a = await fleet();
    const b = await fleet();
    const tripA = await f.activeTrip(a.sid, a.bus.id, { started_at: new Date(Date.now() - 30 * 3600_000).toISOString() });
    const tripB = await f.activeTrip(b.sid, b.bus.id, { started_at: new Date(Date.now() - 30 * 3600_000).toISOString() });
    expect((await staleTripCloser({ schoolId: a.sid })).closed).toBe(1);
    const rows = await ownerQuery<{ id: string; status: string }>('select id, status from trips where id in ($1, $2)', [tripA.id, tripB.id]);
    expect(new Map(rows.rows.map((r) => [r.id, r.status]))).toEqual(new Map([[tripA.id, 'auto_closed'], [tripB.id, 'in_progress']]));
  });
});
