// Seed 75 · tracking history (contract §14): location points for the trips seed 70 created, so the trip
// detail map (planned vs actual path), stop events / dwell, trip summaries and reports have real data.
// For every completed or auto-closed school trip of the demo schools that has a route but no points yet:
//   · a GPS track along the planned route polyline, every 15 s while moving (≈ 3 m deterministic jitter,
//     accuracy 5–12 m, battery draining, 4G) with a 60–90 s dwell inside each stop geofence it reaches;
//   · coverage follows the trip's recorded GPS distance (seed 70): the full route for normal trips, about
//     half of it for the odometer↔GPS mismatch trip and for the auto-closed trip (tracking stopped);
//   · one trip per school (bus R2, afternoon, 2 days ago) has a 4-fix speeding stretch above the school's
//     speed limit, with the speeding alert the live analytics would have raised (when speeding is enabled);
//   · trips.points_count / last_point_at / closed_at are set, then the REAL trip-finalizer runs
//     (finalizeTrip): simplified actual path, stop events + dwell, distance_gps_km, data quality, flags.
// Idempotent: a trip that already has location points is skipped; the finalizer itself is idempotent.
import type { TrackingConfig } from '../../modules/tracking/config.js';
import { toTrackingConfig } from '../../modules/tracking/config.js';
import { finalizeTrip } from '../../modules/tracking/finalizer.js';
import { buildGeometry, type TripGeometry } from '../../modules/tracking/geometry.js';
import * as trackingRepo from '../../modules/tracking/repository.js';
import { raiseAlert } from '../../modules/alerts/service.js';
import { loadSchoolSettings } from '../../modules/school/index.js';
import { bearingDeg, cumulativeDistances, type LatLng } from '../../shared/geo.js';
import type { SeedContext } from '../seed.js';
import type { Tx } from '../tenant.js';
import { DEMO_ROUTES } from './50_routes.js';

/** Seconds between fixes while moving / while dwelling at a stop. */
export const MOVING_STEP_S = 15;
export const DWELL_STEP_S = 30;

export interface SeedPoint {
  ms: number;
  lat: number;
  lng: number;
  spd: number;
  hdg: number | null;
  acc: number;
  bat: number;
  mv: boolean;
}

interface TrackSpec {
  geometry: TripGeometry;
  startMs: number;
  endMs: number;
  /** Fraction of the route covered by GPS (0.3–1). */
  coverage: number;
  /** Deterministic variation per trip. */
  seed: number;
  /** Speed of a 4-fix speeding stretch in the middle of the trip, or null. */
  speedingKmh: number | null;
}

/** Position at `d` metres along the polyline. */
function along(poly: readonly LatLng[], cum: readonly number[], d: number): { p: LatLng; hdg: number } {
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < d) i += 1;
  const a = poly[i - 1]!;
  const b = poly[i]!;
  const seg = cum[i]! - cum[i - 1]!;
  const f = seg > 0 ? Math.min(1, Math.max(0, (d - cum[i - 1]!) / seg)) : 0;
  return { p: { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f }, hdg: Math.round(bearingDeg(a, b)) };
}

/** Pure: a plausible GPS track for one trip (exported for tests). */
export function generateTrack(s: TrackSpec): SeedPoint[] {
  const poly = s.geometry.polyline;
  if (!poly || poly.length < 2 || s.endMs <= s.startMs) return [];
  const cum = cumulativeDistances(poly);
  const coveredM = s.geometry.totalM * Math.min(1, Math.max(0.3, s.coverage));
  const stops = s.geometry.stops.filter((st) => st.progressM <= coveredM);
  const totalS = (s.endMs - s.startMs) / 1000 - 20;
  // Arriving exactly at a stop shortens that step: keep half a step per stop in reserve.
  const reserveS = stops.length * (MOVING_STEP_S / 2) + MOVING_STEP_S;
  // Dwell budgets are whole dwell steps (60 or 90 s, fewer when the trip is short — driving at ~32 km/h
  // comes first), so the time plan is exact and every reached stop is visited.
  const spareS = totalS - reserveS - coveredM / 9;
  const maxSteps = stops.length ? Math.max(1, Math.min(3, Math.floor(spareS / stops.length / DWELL_STEP_S))) : 0;
  const dwellS = stops.map((_st, i) => DWELL_STEP_S * Math.min(maxSteps, 2 + ((s.seed + i) % 2)));
  const movingS = Math.max(totalS - dwellS.reduce((a, b) => a + b, 0) - reserveS, coveredM / 11); // ≤ ~40 km/h average
  const mps = coveredM / movingS;
  const out: SeedPoint[] = [];
  const jitter = (k: number) => ({ dLat: Math.sin(s.seed * 13 + k * 1.7) * 0.00003, dLng: Math.cos(s.seed * 7 + k * 2.3) * 0.00003 });
  let t = s.startMs + 20_000;
  let d = 0;
  let k = 0;
  let stopIdx = 0;
  const push = (pos: LatLng, spd: number, hdg: number | null, mv: boolean) => {
    const j = jitter(k);
    const bat = Math.max(20, 92 - Math.floor(((t - s.startMs) / 60_000) * 0.4) - (s.seed % 5));
    out.push({ ms: t, lat: pos.lat + j.dLat, lng: pos.lng + j.dLng, spd, hdg, acc: 5 + ((s.seed + k) % 8), bat, mv });
    k += 1;
  };
  const speedingFrom = s.speedingKmh !== null ? coveredM * 0.5 : Infinity;
  let speedingLeft = s.speedingKmh !== null ? 4 : 0;
  while (d < coveredM && t <= s.endMs) {
    const stop = stops[stopIdx];
    if (stop && d >= stop.progressM) {
      // Dwell inside the stop geofence.
      const here = along(poly, cum, stop.progressM).p;
      const until = t + dwellS[stopIdx]! * 1000;
      while (t < until && t <= s.endMs) {
        push(here, 0, null, false);
        t += DWELL_STEP_S * 1000;
      }
      stopIdx += 1;
      continue;
    }
    const fast = d >= speedingFrom && speedingLeft > 0;
    const speedMps = fast ? s.speedingKmh! / 3.6 : mps * (0.85 + ((s.seed + k) % 4) * 0.1);
    const { p, hdg } = along(poly, cum, d);
    push(p, Math.round(speedMps * 3.6 * 10) / 10, hdg, true);
    if (fast) speedingLeft -= 1;
    const next = d + speedMps * MOVING_STEP_S;
    // Never jump over a stop: arrive at it on the next fix.
    d = stops[stopIdx] && next > stops[stopIdx]!.progressM ? stops[stopIdx]!.progressM : next;
    t += MOVING_STEP_S * 1000;
  }
  // Last fix at the end of the covered stretch (the school / where tracking stopped).
  if (t <= s.endMs && d >= coveredM) push(along(poly, cum, coveredM).p, 0, null, false);
  return out;
}

async function insertPoints(tx: Tx, schoolId: string, tripId: string, points: readonly SeedPoint[]): Promise<void> {
  if (!points.length) return;
  await tx.query(
    `insert into location_points (school_id, trip_id, recorded_at, latitude, longitude, speed_kmh, heading, accuracy_m, battery_pct, network_type, is_moving, is_backfilled)
     select $1, $2, to_timestamp(p.ms / 1000.0), p.lat, p.lng, p.spd, p.hdg, p.acc, p.bat, '4g', p.mv, false
       from unnest($3::float8[], $4::float8[], $5::float8[], $6::real[], $7::real[], $8::real[], $9::smallint[], $10::boolean[])
              as p(ms, lat, lng, spd, hdg, acc, bat, mv)
     on conflict (trip_id, recorded_at) do nothing`,
    [schoolId, tripId, points.map((p) => p.ms), points.map((p) => p.lat), points.map((p) => p.lng), points.map((p) => p.spd), points.map((p) => p.hdg), points.map((p) => p.acc), points.map((p) => p.bat), points.map((p) => p.mv)],
  );
}

interface HistoryTrip extends Record<string, unknown> {
  id: string;
  bus_id: string;
  bus_code: string | null;
  direction: 'morning' | 'afternoon' | null;
  status: 'completed' | 'auto_closed';
  started_at: string;
  ended_at: string;
  distance_gps_km: number | null;
  distance_odometer_km: number | null;
  driver_staff_id: string | null;
  /** School days (Mon–Sat) ago, as seed 70 counts them: 1 = the last school day before today. */
  days_ago: number;
}

/**
 * SQL for the school days (Mon–Sat) between a trip date and today, counted like seed 70's anomaly plan
 * ("2 days ago" = the second-last school day): 0 for today, 1 for the last school day before it, …
 * Calendar days would drift on Mondays/Tuesdays, when the Sunday lies in between.
 */
export function schoolDaysAgoSql(tripDate: string, today: string): string {
  return `(case when ${tripDate} >= ${today} then 0 else 1 + (select count(*) from generate_series((${tripDate} + 1)::timestamp, (${today} - 1)::timestamp, interval '1 day') g
            where extract(isodow from g) <> 7) end)::int`;
}

async function speedingAlert(tx: Tx, trip: HistoryTrip, cfg: TrackingConfig, points: readonly SeedPoint[]): Promise<number> {
  const fast = points.filter((p) => cfg.speedLimitKmh !== null && p.spd > cfg.speedLimitKmh);
  if (fast.length < 3 || cfg.speedLimitKmh === null || !cfg.speedingEnabled) return 0;
  const third = fast[2]!;
  const max = Math.max(...fast.map((p) => p.spd));
  const a = await raiseAlert(tx, {
    type: 'speeding',
    severity: 'warning',
    title: `Speeding: ${Math.round(max)} km/h (limit ${cfg.speedLimitKmh} km/h)`,
    entity: { type: 'trip', id: trip.id },
    tripId: trip.id,
    busId: trip.bus_id,
    staffId: trip.driver_staff_id,
    details: { speedKmh: max, limitKmh: cfg.speedLimitKmh, at: new Date(third.ms).toISOString(), lat: third.lat, lng: third.lng, points: fast.length },
    dedupeKey: `speeding:${trip.id}`,
    once: true,
  });
  return a ? 1 : 0;
}

async function seedSchool(tx: Tx, schoolId: string): Promise<{ trips: number; points: number; alerts: number }> {
  const settings = await loadSchoolSettings(tx);
  const cfg = toTrackingConfig(settings);
  const trips = await tx.many<HistoryTrip>(
    `select t.id, t.bus_id, t.bus_code_snapshot as bus_code, t.direction, t.status, t.started_at, t.ended_at, t.distance_gps_km::float8 as distance_gps_km, t.distance_odometer_km::float8 as distance_odometer_km,
            t.driver_staff_id, ${schoolDaysAgoSql('t.trip_date', 'app_local_date()')} as days_ago
       from trips t
      where t.school_id = $1 and t.trip_type = 'school' and t.route_id is not null and t.status in ('completed', 'auto_closed')
        and t.started_at is not null and t.ended_at is not null
        and not exists (select 1 from location_points lp where lp.trip_id = t.id)
      order by t.started_at`,
    [schoolId],
  );
  let points = 0;
  let alerts = 0;
  const done: string[] = [];
  for (const [i, trip] of trips.entries()) {
    const row = await trackingRepo.tripGeometry(tx, trip.id);
    const geometry = row ? buildGeometry(row) : null;
    if (!geometry?.polyline || geometry.totalM <= 0) continue;
    // Normal trips: GPS covered the whole route. The planned anomalies of seed 70 (odometer↔GPS mismatch,
    // auto-closed) recorded a much shorter GPS distance: the track stops after that share of the route.
    const routeKm = geometry.totalM / 1000;
    const ratio = trip.distance_gps_km === null ? 1 : trip.distance_gps_km / (trip.distance_odometer_km ?? routeKm);
    const coverage = ratio < 0.8 && trip.distance_gps_km !== null ? trip.distance_gps_km / routeKm : 1;
    const speeding = trip.bus_code === 'R2' && trip.direction === 'afternoon' && trip.days_ago === 2 && cfg.speedLimitKmh !== null ? cfg.speedLimitKmh + 12 : null;
    const track = generateTrack({ geometry, startMs: Date.parse(trip.started_at), endMs: Date.parse(trip.ended_at), coverage, seed: i + 3, speedingKmh: speeding });
    if (track.length < 2) continue;
    await insertPoints(tx, schoolId, trip.id, track);
    if (speeding !== null) alerts += await speedingAlert(tx, trip, cfg, track);
    points += track.length;
    done.push(trip.id);
  }
  if (!done.length) return { trips: 0, points, alerts };
  // Counters + close instant (an auto-closed trip was closed staleTripCloseHours after its last fix).
  await tx.query(
    `update trips t set points_count = c.n, last_point_at = c.last_at,
            closed_at = coalesce(t.closed_at, case when t.status = 'auto_closed' then t.ended_at + make_interval(hours => $2) else t.ended_at end)
       from (select trip_id, count(*)::int as n, max(recorded_at) as last_at from location_points where trip_id = any($1::uuid[]) group by trip_id) c
      where t.id = c.trip_id`,
    [done, settings.effective.staleTripCloseHours],
  );
  for (const id of done) {
    const r = await finalizeTrip(tx, id);
    alerts += r.alerts?.length ?? 0;
  }
  return { trips: done.length, points, alerts };
}

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger } = ctx;
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });
  const schools = await tx.many<{ id: string; code: string }>('select id, code from schools where code = any ($1) and deleted_at is null order by code', [DEMO_ROUTES.map((s) => s.code)]);
  const summary: Record<string, { trips: number; points: number; alerts: number }> = {};
  for (const school of schools) {
    const schoolCtx = { schoolId: school.id, actorId: null, role: 'system' as const };
    await ctx.setContext(schoolCtx);
    // Module code reads the school from tx.ctx (kv keys, geometry): give it this school's context.
    summary[school.code] = await seedSchool({ ...tx, ctx: Object.freeze(schoolCtx) }, school.id);
  }
  logger.info({ summary }, 'Tracking history seed applied');
}
