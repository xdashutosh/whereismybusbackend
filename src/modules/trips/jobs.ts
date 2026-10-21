// Trip jobs (BP §7.3, §10.1; contract §8), registered in src/jobs/index.ts JOB_DEFINITIONS. All are
// school-cron jobs: the dispatcher runs them per active school in the school's own timezone, and each
// handler works inside withSchoolSystem(schoolId) — idempotent, exported for tests.
//   generate-daily-trips    00:05 local: one 'scheduled' trip per active schedule running that local date
//                           (weekday + validity), active bus, active route; holidays skipped (all /
//                           direction); ON CONFLICT (schedule_id, trip_date) DO NOTHING
//   trip-not-started-check  every minute: scheduled trips on a holiday added after generation → cancelled
//                           (and back to scheduled once that holiday is deleted/moved, not yet overdue);
//                           missing not-yet-overdue trips of today created (holiday removed, long outage);
//                           planned start + grace passed → trip_not_started alert (once per trip) and
//                           'trip.not_started' for parent notifications (notify_trip_not_started);
//                           planned start + missedAfterMin passed (or an earlier local date) → missed
//   stale-trip-closer       every 5 min: in-progress trips without points (or since the start) for
//                           stale_trip_close_hours → auto_closed + trip_auto_closed alert, GPS distance
//                           stored, trip-finalizer queued
// Imports only the job registry (not jobs/index.ts), so the registry can import this file.
import type { SchoolSettingsDto } from '@wimb/shared';
import { withSchoolSystem, type Tx } from '../../db/tenant.js';
import { defineSchoolCronJob } from '../../jobs/registry.js';
import type { SchoolCronPayload } from '../../jobs/types.js';
import { audit } from '../../shared/audit.js';
import { events } from '../../shared/events.js';
import { announceAlerts, raiseAlert, type RaisedAlert } from '../alerts/service.js';
import { loadSchoolSettings } from '../school/index.js';
import { enqueueFinalizer, publishTripStatus, statusPayload, type TripNotStartedPayload, type TripStatusPayload } from './events.js';
import { syncPendingTrips } from '../routes/scheduleTrips.js';
import { gpsDistance } from './gps.js';
import { TRIP_COLUMNS, type TripRow } from './repository.js';

export const GENERATE_DAILY_TRIPS_JOB = 'generate-daily-trips';
export const TRIP_NOT_STARTED_JOB = 'trip-not-started-check';
export const STALE_TRIP_CLOSER_JOB = 'stale-trip-closer';

/** A scheduled trip becomes 'missed' this long after its planned start (at least grace + 30 min). */
export const MISSED_AFTER_MIN = 180;
export const missedAfterMin = (graceMin: number): number => Math.max(MISSED_AFTER_MIN, graceMin + 30);
const MAX_AUDIT_IDS = 200;

// ── generate-daily-trips ─────────────────────────────────────────────────────
export interface GenerateOptions {
  /** Only this schedule (schedule created / re-activated / re-matched during the day). */
  scheduleId?: string | null;
  /**
   * Only runs that are not overdue yet: planned start + this many minutes still ahead (on-demand
   * generation during the day — never a trip that would at once be "not started").
   */
  upcomingGraceMin?: number | null;
}

/** Creates the scheduled trips of one school-local date (current school context). Returns the new ids. */
export async function generateTripsForDate(tx: Tx, localDate: string, opts: GenerateOptions = {}): Promise<string[]> {
  const staffAt = (role: string) => `left join lateral (
       select sp.id, sp.full_name from bus_staff_assignments a
         join staff_profiles sp on sp.id = a.staff_id and sp.deleted_at is null and sp.is_active
        where a.bus_id = p.bus_id and a.assignment_role = '${role}' and a.valid_from <= p.planned_at and (a.valid_to is null or a.valid_to > p.planned_at)
        order by a.valid_from desc limit 1) ${role === 'primary_driver' ? 'd' : 'c'} on true`;
  const rows = await tx.many<{ id: string }>(
    `with p as (
       select ts.id as schedule_id, ts.school_id, ts.bus_id, ts.route_id, ts.direction, b.code as bus_code, b.registration_no,
              r.code as route_code, r.name as route_name, ($1::date + ts.planned_start_time) at time zone sc.timezone as planned_at
         from trip_schedules ts
         join buses b on b.id = ts.bus_id and b.deleted_at is null and b.status = 'active'
         join routes r on r.id = ts.route_id and r.deleted_at is null and r.is_active
         join schools sc on sc.id = ts.school_id
        where ts.deleted_at is null and ts.is_active
          and extract(isodow from $1::date)::smallint = any (ts.days_of_week)
          and (ts.valid_from is null or ts.valid_from <= $1::date) and (ts.valid_to is null or ts.valid_to >= $1::date)
          and not exists (select 1 from school_holidays h
                           where h.start_date <= $1::date and h.end_date >= $1::date and h.applies_to in ('all', ts.direction))
          and ($2::uuid is null or ts.id = $2::uuid)
     )
     insert into trips (school_id, schedule_id, trip_type, direction, trip_date, bus_id, route_id, driver_staff_id, conductor_staff_id,
                        bus_code_snapshot, bus_registration_snapshot, route_code_snapshot, route_name_snapshot, driver_name_snapshot,
                        conductor_name_snapshot, status, planned_start_at)
     select p.school_id, p.schedule_id, 'school', p.direction, $1::date, p.bus_id, p.route_id, d.id, c.id,
            p.bus_code, p.registration_no, p.route_code, p.route_name, d.full_name, c.full_name, 'scheduled', p.planned_at
       from p ${staffAt('primary_driver')} ${staffAt('conductor')}
      where ($3::int is null or p.planned_at + make_interval(mins => $3::int) > now())
     on conflict (schedule_id, trip_date) where schedule_id is not null do nothing
     returning id`,
    [localDate, opts.scheduleId ?? null, opts.upcomingGraceMin ?? null],
  );
  return rows.map((r) => r.id);
}

export async function generateDailyTrips({ schoolId, localDate }: Pick<SchoolCronPayload, 'schoolId' | 'localDate'>): Promise<{ created: number }> {
  return withSchoolSystem(schoolId, async (tx) => {
    const ids = await generateTripsForDate(tx, localDate);
    if (ids.length) {
      await audit.log(tx, { action: 'trip.generate', entityType: 'trip', actorName: GENERATE_DAILY_TRIPS_JOB, new: { localDate, created: ids.length, tripIds: ids.slice(0, MAX_AUDIT_IDS) } });
    }
    return { created: ids.length };
  });
}

// ── restoring trips cancelled by a schedule / calendar change ────────────────
/** cancel_reason values written by routes/scheduleTrips when a schedule edit cancels pending trips. */
export const SCHEDULE_CANCEL_REASONS = ['Schedule deactivated', 'Schedule changed'] as const;
/** cancel_reason prefix written by trip-not-started-check for a holiday added after generation. */
export const HOLIDAY_CANCEL_PREFIX = 'School holiday: ';

/** Today's date of the current school ('YYYY-MM-DD', school-local). */
export async function schoolToday(tx: Tx): Promise<string> {
  return (await tx.one<{ d: string }>(`select to_char(app_local_date(), 'YYYY-MM-DD') as d`)).d;
}

/**
 * Puts back to 'scheduled' the not-yet-started school trips (today or later, school-local) that a
 * schedule edit ('schedule') or a holiday ('holiday', cancelled by the job: no actor) cancelled, when
 * their schedule runs on that date again (active, weekday + validity, active bus and route, no
 * covering holiday) and the run is not yet past the missed window. Trips an admin cancelled by hand
 * keep their status. Returns the revived trips (current school context).
 */
export async function reviveCancelledTrips(tx: Tx, a: { kind: 'schedule' | 'holiday'; scheduleId?: string | null; missedAfterMin: number }): Promise<TripRow[]> {
  const reason =
    a.kind === 'schedule' ? `t.cancel_reason = any ($3::text[])` : `t.cancel_reason like ($3::text[])[1] || '%' and t.cancelled_by is null`;
  return tx.many<TripRow>(
    `update trips t set status = 'scheduled', cancel_reason = null, cancelled_by = null, updated_at = now()
       from trip_schedules ts
       join buses b on b.id = ts.bus_id and b.deleted_at is null and b.status = 'active'
       join routes r on r.id = ts.route_id and r.deleted_at is null and r.is_active
       join schools sc on sc.id = ts.school_id
      where t.schedule_id = ts.id and t.status = 'cancelled' and t.trip_type = 'school' and t.started_at is null
        and t.trip_date >= app_local_date()
        and ($1::uuid is null or ts.id = $1::uuid)
        and ${reason}
        and ts.deleted_at is null and ts.is_active
        and extract(isodow from t.trip_date)::smallint = any (ts.days_of_week)
        and (ts.valid_from is null or ts.valid_from <= t.trip_date) and (ts.valid_to is null or ts.valid_to >= t.trip_date)
        and not exists (select 1 from school_holidays h
                         where h.start_date <= t.trip_date and h.end_date >= t.trip_date and h.applies_to in ('all', ts.direction))
        and ((t.trip_date + ts.planned_start_time) at time zone sc.timezone) + make_interval(mins => $2::int) > now()
      returning ${TRIP_COLUMNS}`,
    [a.scheduleId ?? null, a.missedAfterMin, a.kind === 'schedule' ? [...SCHEDULE_CANCEL_REASONS] : [HOLIDAY_CANCEL_PREFIX]],
  );
}

/**
 * After a schedule is created, re-activated or edited during the day (current school, inside the
 * admin's transaction): trips the schedule's earlier state cancelled come back when it runs on their
 * date again (aligned with the schedule), and today's trip is created when it is missing and not
 * overdue — the 00:05 generation has already run, and the driver can only start a trip dated today.
 */
export async function restoreScheduleTrips(tx: Tx, scheduleId: string): Promise<{ restored: number; created: number }> {
  const grace = (await loadSchoolSettings(tx)).tripNotStartedGraceMin;
  const revived = await reviveCancelledTrips(tx, { kind: 'schedule', scheduleId, missedAfterMin: missedAfterMin(grace) });
  if (revived.length) await syncPendingTrips(tx, scheduleId, 'Schedule changed');
  const created = await generateTripsForDate(tx, await schoolToday(tx), { scheduleId, upcomingGraceMin: grace });
  return { restored: revived.length, created: created.length };
}

// ── trip-not-started-check ───────────────────────────────────────────────────
export interface NotStartedResult {
  alerted: number;
  missed: number;
  holidayCancelled: number;
}

export async function tripNotStartedCheck({ schoolId }: Pick<SchoolCronPayload, 'schoolId'>): Promise<NotStartedResult> {
  const out = await withSchoolSystem(schoolId, async (tx) => {
    const settings: SchoolSettingsDto = await loadSchoolSettings(tx);
    const grace = settings.tripNotStartedGraceMin;
    const statuses: TripStatusPayload[] = [];

    const covering = `from school_holidays hh
       where hh.start_date <= t.trip_date and hh.end_date >= t.trip_date and hh.applies_to in ('all', t.direction)`;
    const holiday = await tx.many<TripRow>(
      `update trips t set status = 'cancelled', updated_at = now(),
              cancel_reason = $1 || (select hh.name ${covering} order by hh.start_date, hh.id limit 1)
        where t.status = 'scheduled' and t.trip_type = 'school' and t.trip_date >= app_local_date() - 1
          and exists (select 1 ${covering})
       returning ${TRIP_COLUMNS}`,
      [HOLIDAY_CANCEL_PREFIX],
    );
    for (const t of holiday) statuses.push(statusPayload(t, 'scheduled', t.cancel_reason));

    // A holiday deleted or shortened during the day: the trips it cancelled run again, and trips it kept
    // the 00:05 generation from creating (or any run missed while the jobs were down longer than the
    // dispatcher catch-up) are created while they are not overdue yet. Both are no-ops normally.
    const restored = await reviveCancelledTrips(tx, { kind: 'holiday', missedAfterMin: missedAfterMin(grace) });
    for (const t of restored) {
      if (t.schedule_id) await syncPendingTrips(tx, t.schedule_id, 'Schedule changed');
      statuses.push(statusPayload(t, 'cancelled', 'Holiday removed'));
    }
    const created = await generateTripsForDate(tx, await schoolToday(tx), { upcomingGraceMin: grace });

    const overdue = await tx.many<TripRow>(
      `select ${TRIP_COLUMNS} from trips t
        where t.status = 'scheduled' and t.planned_start_at is not null
          and t.planned_start_at + make_interval(mins => $1) <= now() and t.planned_start_at > now() - interval '24 hours'
          and not exists (select 1 from alerts a where a.school_id = t.school_id and a.dedupe_key = 'trip_not_started:' || t.id::text)
        order by t.planned_start_at`,
      [grace],
    );
    const alerts: RaisedAlert[] = [];
    const notStarted: TripNotStartedPayload[] = [];
    for (const t of overdue) {
      const a = await raiseAlert(tx, {
        type: 'trip_not_started',
        severity: 'warning',
        title: `Bus ${t.bus_code_snapshot ?? ''} ${t.direction ?? ''} trip ${t.route_code_snapshot ?? ''} has not started`.replace(/\s+/g, ' ').trim(),
        entity: { type: 'trip', id: t.id },
        tripId: t.id,
        busId: t.bus_id,
        staffId: t.driver_staff_id,
        details: { plannedStartAt: t.planned_start_at, graceMin: grace, tripDate: t.trip_date, routeCode: t.route_code_snapshot, driverName: t.driver_name_snapshot },
        dedupeKey: `trip_not_started:${t.id}`,
        once: true,
      });
      if (!a) continue;
      alerts.push(a);
      if (settings.notifyTripNotStarted) {
        notStarted.push({ schoolId, tripId: t.id, busId: t.bus_id, routeId: t.route_id, direction: t.direction, tripDate: t.trip_date, plannedStartAt: t.planned_start_at!, busCode: t.bus_code_snapshot });
      }
    }

    const missed = await tx.many<TripRow>(
      `update trips t set status = 'missed', close_reason = $2, updated_at = now()
        where t.status = 'scheduled'
          and ((t.planned_start_at is not null and t.planned_start_at + make_interval(mins => $1) <= now())
               or t.trip_date < app_local_date())
       returning ${TRIP_COLUMNS}`,
      [missedAfterMin(grace), `Not started within ${missedAfterMin(grace)} minutes of the planned start`],
    );
    for (const t of missed) statuses.push(statusPayload(t, 'scheduled', t.close_reason));
    if (holiday.length || missed.length || restored.length || created.length) {
      await audit.log(tx, {
        action: 'trip.not_started_check',
        entityType: 'trip',
        actorName: TRIP_NOT_STARTED_JOB,
        new: {
          holidayCancelled: holiday.map((t) => t.id).slice(0, MAX_AUDIT_IDS),
          missed: missed.map((t) => t.id).slice(0, MAX_AUDIT_IDS),
          ...(restored.length ? { holidayRestored: restored.map((t) => t.id).slice(0, MAX_AUDIT_IDS) } : {}),
          ...(created.length ? { created: created.slice(0, MAX_AUDIT_IDS) } : {}),
        },
      });
    }
    return { statuses, alerts, notStarted, counts: { alerted: alerts.length, missed: missed.length, holidayCancelled: holiday.length } };
  });
  for (const p of out.statuses) await publishTripStatus(p);
  for (const n of out.notStarted) events.emit('trip.not_started', n);
  await announceAlerts(out.alerts);
  return out.counts;
}

// ── stale-trip-closer ────────────────────────────────────────────────────────
export async function staleTripCloser({ schoolId }: Pick<SchoolCronPayload, 'schoolId'>): Promise<{ closed: number }> {
  const out = await withSchoolSystem(schoolId, async (tx) => {
    const hours = (await loadSchoolSettings(tx)).effective.staleTripCloseHours;
    const reason = `No location data for ${hours} hour${hours === 1 ? '' : 's'}: closed automatically`;
    const closed = await tx.many<TripRow>(
      `update trips t set status = 'auto_closed', ended_at = greatest(t.started_at, coalesce(t.last_point_at, t.started_at)),
              closed_at = greatest(now(), t.started_at), close_reason = $2, updated_at = now()
        where t.status = 'in_progress' and coalesce(t.last_point_at, t.started_at) < now() - make_interval(hours => $1)
       returning ${TRIP_COLUMNS}`,
      [hours, reason],
    );
    const alerts: RaisedAlert[] = [];
    const statuses: TripStatusPayload[] = [];
    for (const t of closed) {
      const gps = await gpsDistance(tx, t);
      if (gps.km !== null) await tx.query('update trips set distance_gps_km = $2 where id = $1', [t.id, gps.km]);
      const a = await raiseAlert(tx, {
        type: 'trip_auto_closed',
        severity: 'warning',
        title: `Bus ${t.bus_code_snapshot ?? ''}: trip closed automatically (no location data for ${hours} h)`.replace(/\s+/g, ' '),
        entity: { type: 'trip', id: t.id },
        tripId: t.id,
        busId: t.bus_id,
        staffId: t.driver_staff_id,
        details: { startedAt: t.started_at, lastPointAt: t.last_point_at, staleHours: hours, startOdometer: t.start_odometer, gpsKm: gps.km },
        dedupeKey: `trip_auto_closed:${t.id}`,
        once: true,
      });
      if (a) alerts.push(a);
      await audit.log(tx, { action: 'trip.auto_close', entityType: 'trip', entityId: t.id, actorName: STALE_TRIP_CLOSER_JOB, old: { status: 'in_progress' }, new: { status: t.status, endedAt: t.ended_at, reason, gpsKm: gps.km } });
      statuses.push(statusPayload(t, 'in_progress', reason));
    }
    return { alerts, statuses };
  });
  for (const p of out.statuses) {
    await publishTripStatus(p);
    await enqueueFinalizer(schoolId, p.tripId);
  }
  await announceAlerts(out.alerts);
  return { closed: out.statuses.length };
}

export const generateDailyTripsJob = defineSchoolCronJob({ name: GENERATE_DAILY_TRIPS_JOB, cron: '5 0 * * *', attempts: 3, handler: async (p) => void (await generateDailyTrips(p)) });
export const tripNotStartedJob = defineSchoolCronJob({ name: TRIP_NOT_STARTED_JOB, cron: '* * * * *', handler: async (p) => void (await tripNotStartedCheck(p)) });
export const staleTripCloserJob = defineSchoolCronJob({ name: STALE_TRIP_CLOSER_JOB, cron: '*/5 * * * *', handler: async (p) => void (await staleTripCloser(p)) });

export const TRIP_JOB_DEFINITIONS = [generateDailyTripsJob, tripNotStartedJob, staleTripCloserJob] as const;
