// Pure trip rules (odometer gap / GPS mismatch decisions, trip config, late-points window) and the
// raiseAlert API the trips module introduces for every alert producer (dedupe on open alerts, `once`,
// school from the transaction context, RLS).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchoolSystem, withTenant } from '../src/db/tenant.js';
import { raiseAlert } from '../src/modules/alerts/service.js';
import { acceptsLatePoints, gapVerdict, gpsMismatch, tripConfigOf } from '../src/modules/trips/index.js';
import { missedAfterMin } from '../src/modules/trips/jobs.js';
import { loadSchoolSettings } from '../src/modules/school/index.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
});
afterAll(closeDb);

describe('gapVerdict (BP §10.3 rule 4)', () => {
  it('classifies the start reading against the previous end', () => {
    expect(gapVerdict(1005, 1000, 5)).toEqual({ kind: 'none' });
    expect(gapVerdict(1005.1, 1000, 5)).toEqual({ kind: 'gap', gapKm: 5.1, severity: 'warning' });
    expect(gapVerdict(1020, 1000, 5)).toEqual({ kind: 'gap', gapKm: 20, severity: 'warning' });
    expect(gapVerdict(1020.1, 1000, 5)).toEqual({ kind: 'gap', gapKm: 20.1, severity: 'critical' });
    expect(gapVerdict(999.9, 1000, 5)).toEqual({ kind: 'decrease', gapKm: -0.1 });
    expect(gapVerdict(1000.1, 1000, 0)).toMatchObject({ kind: 'gap' });
  });
});

describe('gpsMismatch (BP §10.3 rule 3)', () => {
  it('needs both the relative variance and the absolute minimum', () => {
    expect(gpsMismatch(20, 12, 15, 2)).toEqual({ mismatch: true, diffKm: 8, pct: 40 });
    expect(gpsMismatch(20, 17.5, 15, 2)).toEqual({ mismatch: false, diffKm: 2.5, pct: 12.5 });
    expect(gpsMismatch(1.5, 0.5, 15, 2)).toEqual({ mismatch: false, diffKm: 1, pct: 66.7 });
    expect(gpsMismatch(12, 20, 15, 2)).toMatchObject({ mismatch: true, pct: 40 });
    expect(gpsMismatch(0, 0, 15, 0)).toEqual({ mismatch: false, diffKm: 0, pct: 0 });
    expect(gpsMismatch(10, 0, 15, 2)).toEqual({ mismatch: true, diffKm: 10, pct: 100 });
  });
});

describe('late points and missed window', () => {
  it('accepts points while running and for 24 h after the end', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(acceptsLatePoints({ status: 'in_progress', ended_at: null }, now)).toBe(true);
    expect(acceptsLatePoints({ status: 'completed', ended_at: '2026-10-17T12:00:01Z' }, now)).toBe(true);
    expect(acceptsLatePoints({ status: 'auto_closed', ended_at: '2026-10-17T11:59:59Z' }, now)).toBe(false);
    expect(acceptsLatePoints({ status: 'cancelled', ended_at: '2026-10-18T11:00:00Z' }, now)).toBe(false);
    // Cancelled while running (breakdown): the queued points up to the cancel, within the same window.
    expect(acceptsLatePoints({ status: 'cancelled', started_at: '2026-10-18T10:00:00Z', ended_at: '2026-10-18T11:00:00Z', closed_at: '2026-10-18T11:00:00Z' }, now)).toBe(true);
    expect(acceptsLatePoints({ status: 'cancelled', started_at: '2026-10-17T10:00:00Z', ended_at: '2026-10-17T11:00:00Z', closed_at: '2026-10-17T11:00:00Z' }, now)).toBe(false);
    expect(acceptsLatePoints({ status: 'cancelled', started_at: null, ended_at: null, closed_at: null }, now)).toBe(false);
    expect(acceptsLatePoints({ status: 'scheduled', ended_at: null }, now)).toBe(false);
  });

  it('marks trips missed 3 h after the planned start, never before grace + 30 min', () => {
    expect(missedAfterMin(10)).toBe(180);
    expect(missedAfterMin(240)).toBe(270);
  });
});

describe('tripConfigOf', () => {
  it('derives the driver-app configuration from the school settings (10-s floor)', async () => {
    const s = await f.school();
    await f.schoolSettings(s.id, { location_moving_interval_s: 15, allow_non_school_trips: true, odometer_gallery_allowed: true, stale_trip_close_hours: 4 });
    const settings = await withSchoolSystem(s.id, (tx) => loadSchoolSettings(tx));
    expect(tripConfigOf(settings)).toMatchObject({
      movingIntervalS: 15, minIntervalS: 10, latePointsWindowHours: 24, allowNonSchoolTrips: true, odometerGalleryAllowed: true,
      allowBackupDriverStart: true, odometerMismatchThresholdKm: 5, odometerGpsVariancePct: 15, odometerGpsMinKm: 2, tripNotStartedGraceMin: 10, staleTripCloseHours: 4,
    });
  });
});

describe('raiseAlert', () => {
  it('stores an alert of the current school and deduplicates open alerts by key', async () => {
    const s = await f.school();
    const bus = await f.bus(s.id);
    const input = { type: 'low_battery' as const, severity: 'warning' as const, title: '  Battery low  ', busId: bus.id, entity: { type: 'bus' as const, id: bus.id }, details: { pct: 9 }, dedupeKey: `low_battery:${bus.id}` };
    const first = await withSchoolSystem(s.id, (tx) => raiseAlert(tx, input));
    expect(first).toMatchObject({ schoolId: s.id, type: 'low_battery', severity: 'warning', status: 'open', title: 'Battery low', busId: bus.id, entityType: 'bus', details: { pct: 9 } });
    expect(await withSchoolSystem(s.id, (tx) => raiseAlert(tx, input))).toBeNull();
    await ownerQuery("update alerts set status = 'closed' where id = $1", [first!.id]);
    expect(await withSchoolSystem(s.id, (tx) => raiseAlert(tx, input))).not.toBeNull();
    expect(await withSchoolSystem(s.id, (tx) => raiseAlert(tx, { ...input, dedupeKey: null }))).not.toBeNull();
    const n = await ownerQuery('select count(*)::int as n from alerts where school_id = $1', [s.id]);
    expect(n.rows[0]!.n).toBe(3);
  });

  it('`once` never raises a key again, whatever the status; keys are per school', async () => {
    const a = await f.school();
    const b = await f.school();
    const input = { type: 'trip_not_started' as const, severity: 'warning' as const, title: 'Not started', dedupeKey: 'trip_not_started:same-key', once: true };
    const first = await withSchoolSystem(a.id, (tx) => raiseAlert(tx, input));
    await ownerQuery("update alerts set status = 'closed' where id = $1", [first!.id]);
    expect(await withSchoolSystem(a.id, (tx) => raiseAlert(tx, input))).toBeNull();
    expect(await withSchoolSystem(b.id, (tx) => raiseAlert(tx, input))).toMatchObject({ schoolId: b.id });
  });

  it('runs under RLS: a driver context writes its own school only', async () => {
    const s = await f.school();
    const driver = await f.user(s.id, { role: 'driver' });
    const raised = await withTenant({ schoolId: s.id, actorId: driver.id, role: 'driver' }, (tx) => raiseAlert(tx, { type: 'gps_disabled', severity: 'warning', title: 'GPS off' }));
    expect(raised?.schoolId).toBe(s.id);
  });
});
