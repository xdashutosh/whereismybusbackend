// Integrity constraints of the core schema (BP §6.2, §10.2, §11): one active trip per bus /
// driver / conductor, one open primary driver, one open assignment per direction, alert and
// notification dedupe, client_start_id idempotency, schedule-per-day uniqueness, deferrable stop
// sequences, composite tenant foreign keys and CHECK rules. Fixtures are written as the owner;
// constraint names are what modules map with registerConstraintError().
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as F from './helpers/factories.js';

let f: F.TwoSchoolFixture;

/** Expects the promise to fail with SQLSTATE `code` (and constraint name when given). */
async function rejects(p: Promise<unknown>, code: string, constraint?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e as { code?: string; constraint?: string },
  );
  expect(err, 'expected a database error').not.toBeNull();
  expect(err!.code).toBe(code);
  if (constraint) expect(err!.constraint).toBe(constraint);
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  f = await F.twoSchoolFixture();
});

afterAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  await closeDb();
});

describe('trips', () => {
  it('one in-progress trip per bus, per driver and per conductor', async () => {
    const sid = f.a.school.id;
    await rejects(F.activeTrip(sid, f.a.bus.id), '23505', 'one_active_trip_per_bus');
    const spare = await F.bus(sid);
    await rejects(F.activeTrip(sid, spare.id, { driver_staff_id: f.a.driver.id }), '23505', 'one_active_trip_per_driver');
    await rejects(F.activeTrip(sid, spare.id, { conductor_staff_id: f.a.conductor.id }), '23505', 'one_active_trip_per_conductor');
    // A completed trip of the same bus/driver is fine.
    await F.trip(sid, f.a.bus.id, { status: 'completed', started_at: new Date(Date.now() - 7_200_000).toISOString(), ended_at: new Date().toISOString(), driver_staff_id: f.a.driver.id, trip_date: F.isoDay(-2) });
  });

  it('client_start_id is unique (driver-app idempotency) and schedules create one trip per date', async () => {
    const sid = f.a.school.id;
    const key = '11111111-2222-4333-8444-555555555555';
    const spare = await F.bus(sid);
    await F.trip(sid, spare.id, { client_start_id: key, trip_date: F.isoDay(-3) });
    await rejects(F.trip(sid, spare.id, { client_start_id: key, trip_date: F.isoDay(-4) }), '23505', 'trips_client_start_id_key');
    await rejects(F.trip(sid, f.a.bus.id, { schedule_id: f.a.schedule.id }), '23505', 'trips_schedule_date_uq');
  });

  it('enforces trip CHECK rules (purpose, odometer order, started_at, direction)', async () => {
    const sid = f.a.school.id;
    await rejects(F.trip(sid, f.a.bus.id, { trip_type: 'non_school', direction: null, purpose: ' ' }), '23514', 'trips_non_school_purpose_ck');
    await rejects(F.trip(sid, f.a.bus.id, { start_odometer: 500, end_odometer: 400, trip_date: F.isoDay(-9) }), '23514', 'trips_odometer_order_ck');
    const spare = await F.bus(sid);
    await rejects(F.trip(sid, spare.id, { status: 'in_progress' }), '23514', 'trips_started_ck');
    await rejects(F.trip(sid, spare.id, { status: 'completed', started_at: new Date().toISOString(), trip_date: F.isoDay(-9) }), '23514', 'trips_ended_ck');
    await rejects(F.trip(sid, f.a.bus.id, { direction: null }), '23514', 'trips_school_trip_ck');
    await rejects(F.trip(sid, f.a.bus.id, { status: 'paused' }), '23514');
  });

  it('only one start and one end odometer evidence per trip', async () => {
    await rejects(F.tripOdometerEvidence(f.a.school.id, f.a.trip.id, { kind: 'start' }), '23505', 'trip_odometer_evidence_one_per_kind');
    await F.tripOdometerEvidence(f.a.school.id, f.a.trip.id, { kind: 'end', reading: 1012 });
  });
});

describe('assignments', () => {
  it('at most one open primary driver per bus; overlapping duplicates are excluded', async () => {
    const sid = f.a.school.id;
    const other = await F.staffProfile(sid);
    await rejects(F.busStaffAssignment(sid, f.a.bus.id, other.id, { assignment_role: 'primary_driver' }), '23505', 'one_primary_driver');
    await F.busStaffAssignment(sid, f.a.bus.id, other.id, { assignment_role: 'backup_driver' });
    await rejects(F.busStaffAssignment(sid, f.a.bus.id, other.id, { assignment_role: 'backup_conductor' }), '23P01', 'bus_staff_assignments_no_overlap');
  });

  it('one open assignment per student and direction; history windows never overlap', async () => {
    const sid = f.a.school.id;
    const a = { studentId: f.a.student.id, busId: f.a.bus.id, routeId: f.a.route.id, stopId: f.a.stop2.id };
    await rejects(F.studentAssignment(sid, a), '23505', 'one_open_assignment');
    await rejects(F.studentAssignment(sid, a, { valid_from: F.isoDay(-60), valid_to: F.isoDay(-10) }), '23P01', 'student_assignments_no_overlap');
    await F.studentAssignment(sid, a, { valid_from: F.isoDay(-90), valid_to: F.isoDay(-30) }); // adjacent [d-90, d-30) is fine
    const afternoon = await F.route(sid, { code: 'R1', name: 'Route 1', direction: 'afternoon' });
    const pm = await F.stop(sid, afternoon.id, { name: 'Stop 1', sequence: 1 });
    await F.studentAssignment(sid, { ...a, routeId: afternoon.id, stopId: pm.id, direction: 'afternoon' });
  });

  it('the stop must belong to the route, the route must match the direction, all within one school', async () => {
    const sid = f.a.school.id;
    const base = { studentId: f.a.otherStudent.id, busId: f.a.bus.id, routeId: f.a.route.id };
    const otherStop = await ownerQuery<{ id: string }>('select id from stops where route_id = $1', [f.a.otherRoute.id]);
    await ownerQuery('delete from student_assignments where student_id = $1', [f.a.otherStudent.id]);
    await rejects(F.studentAssignment(sid, { ...base, stopId: otherStop.rows[0]!.id }), '23503');
    await rejects(F.studentAssignment(sid, { ...base, stopId: f.a.stop1.id, direction: 'afternoon' }), '23503');
    await rejects(F.studentAssignment(sid, { ...base, stopId: f.b.stop1.id }), '23503');
    await rejects(F.studentAssignment(sid, { ...base, busId: f.b.bus.id, stopId: f.a.stop1.id }), '23503');
  });

  it('students can only be linked to parents registered with that school', async () => {
    await rejects(F.studentParent(f.a.school.id, f.a.otherStudent.id, f.b.parent.id), '23503');
  });
});

describe('alerts and notifications', () => {
  it('dedupes open/escalated alerts per school and key, allows a new one after closing', async () => {
    const sid = f.a.school.id;
    await F.alert(sid, { dedupe_key: 'doc_expiring:doc-1:30' });
    await rejects(F.alert(sid, { dedupe_key: 'doc_expiring:doc-1:30', status: 'escalated' }), '23505', 'alerts_dedupe');
    await F.alert(f.b.school.id, { dedupe_key: 'doc_expiring:doc-1:30' }); // other school: independent
    await ownerQuery("update alerts set status = 'closed' where school_id = $1 and dedupe_key = 'doc_expiring:doc-1:30'", [sid]);
    await F.alert(sid, { dedupe_key: 'doc_expiring:doc-1:30' });
  });

  it('one notification event per trip, student and event type', async () => {
    await rejects(F.notificationEvent(f.a.school.id, f.a.trip.id, { student_id: f.a.student.id }), '23505', 'notification_events_dedupe');
    await F.notificationEvent(f.a.school.id, f.a.trip.id, { student_id: f.a.student.id, event_type: 'arrived_at_stop' });
  });
});

describe('stops, documents, identities', () => {
  it('stop sequences are unique among live stops and can be permuted in one statement', async () => {
    const sid = f.a.school.id;
    await rejects(F.stop(sid, f.a.route.id, { name: 'Dup', sequence: 1 }), '23P01', 'stops_route_sequence_uq');
    const swapped = await withTenant(F.contexts.schoolAdmin(sid, f.a.admin.id), (tx) =>
      tx.query('update stops set sequence = case sequence when 1 then 2 else 1 end where route_id = $1 and sequence in (1, 2)', [f.a.route.id]),
    );
    expect(swapped.rowCount).toBe(2);
    await ownerQuery('update stops set deleted_at = now() where id = $1', [f.a.stop1.id]);
    await F.stop(sid, f.a.route.id, { name: 'Replacement', sequence: 2 }); // soft-deleted stop frees its slot
    const geo = await ownerQuery<{ ok: boolean }>('select st_dwithin(geom, st_makepoint(77.6245, 12.9352)::geography, 5) as ok from stops where id = $1', [f.a.stop1.id]);
    expect(geo.rows[0]!.ok).toBe(true);
  });

  it('one current document per type (except other/training); identity files never parent-visible', async () => {
    await rejects(F.busDocument(f.a.school.id, f.a.bus.id, { doc_type: 'insurance' }), '23505', 'bus_documents_one_current');
    await F.busDocument(f.a.school.id, f.a.bus.id, { doc_type: 'other' });
    await F.busDocument(f.a.school.id, f.a.bus.id, { doc_type: 'other' });
    await rejects(F.staffDocument(f.a.school.id, f.a.driver.id, { doc_type: 'identity', is_current: false, visible_to_parents_file: true }), '23514', 'staff_documents_identity_private_ck');
  });

  it('login identifiers: global admin email, per-school staff phone, E.164 phones, school codes', async () => {
    const email = `dup-${F.nextSeq()}@school.test`;
    await F.user(f.a.school.id, { email });
    await rejects(F.user(f.b.school.id, { email }), '23505', 'users_admin_email_uq');
    const phone = F.uniquePhone();
    await F.user(f.a.school.id, { role: 'driver', phone });
    await F.user(f.b.school.id, { role: 'driver', phone }); // same phone in another school is fine
    await rejects(F.user(f.a.school.id, { role: 'conductor', phone }), '23505', 'users_staff_phone_uq');
    await rejects(F.parentAccount({ phone: '9876543210' }), '23514');
    await rejects(F.school({ code: 'bad code' }), '23514');
    await rejects(F.parentAccount({ phone: f.a.parent.phone }), '23505', 'parent_accounts_phone_key');
  });

  it('devices and sessions carry a school exactly when they belong to a school user', async () => {
    await rejects(F.device({ owner_type: 'parent_account', owner_id: f.a.parent.id, school_id: f.a.school.id }), '23514', 'devices_school_ck');
    await rejects(F.session({ owner_type: 'user', owner_id: f.a.admin.id }), '23514', 'sessions_school_ck');
  });
});

describe('location points', () => {
  it('dedupes on (trip_id, recorded_at); points outside the monthly partitions land in the DEFAULT partition', async () => {
    const sid = f.a.school.id;
    const at = new Date().toISOString();
    const sql = `insert into location_points (school_id, trip_id, recorded_at, latitude, longitude) values ($1, $2, $3, 12.9, 77.6) on conflict do nothing`;
    expect((await ownerQuery(sql, [sid, f.a.trip.id, at])).rowCount).toBe(1);
    expect((await ownerQuery(sql, [sid, f.a.trip.id, at])).rowCount).toBe(0);
    expect((await ownerQuery(sql, [sid, f.a.trip.id, '1999-01-01T00:00:00Z'])).rowCount).toBe(1);
    const placed = await ownerQuery<{ part: string }>("select tableoid::regclass::text as part from location_points where trip_id = $1 and recorded_at = '1999-01-01T00:00:00Z'", [f.a.trip.id]);
    expect(placed.rows[0]?.part).toBe('location_points_default');
    await rejects(ownerQuery(sql, [f.b.school.id, f.a.trip.id, new Date(Date.now() - 5000).toISOString()]), '23503'); // trip of another school
  });
});
