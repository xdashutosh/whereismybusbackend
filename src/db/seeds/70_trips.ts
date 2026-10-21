// Seed 70 · trips (contract §14): per demo school the trips of the last five school days (Mon–Sat, holidays
// skipped) generated from the schedules exactly like the generate-daily-trips job, then completed with
// continuous odometer readings ending at the bus's last known reading, odometer evidence photos (rendered
// JPEGs stored through the storage driver, camera source, SHA-256), GPS distances, and a few anomalies with
// their alerts — decided by the real odometer rules with each school's thresholds — so dashboards, reports
// and the Trips & Audit screens are populated:
//   · bus R2 morning, 3 days ago: unexplained odometer gap (odometer_gap)
//   · bus R1 morning, 2 days ago: odometer ↔ GPS mismatch (odometer_gps_mismatch)
//   · bus R1 afternoon, 4 days ago: auto-closed without an end reading (trip_auto_closed); the next R1 trip
//     then starts beyond the last recorded end reading, so the start rule flags it (odometer_gap)
//   · bus R2 afternoon, yesterday: never started → missed (trip_not_started)
//   · bus R1, yesterday evening: non-school trip "Service at the authorised workshop" (non_school_trip)
// Start/end positions (trips.start_/end_lat/lng and the odometer evidence) follow the route's planned path
// (routes/path.ts): a morning trip starts at its first pick-up stop and ends at the school, an afternoon
// trip leaves the school and ends at its last drop stop — a few metres of deterministic jitter, the same
// positions on the evidence photo metadata. The non-school trip starts and ends at the school.
// Today's scheduled trips are generated too (the job keeps generating the following days). Location points,
// stop events and trip summaries of these trips come from seed 75_tracking.
// Idempotent: history is created only for schools without any closed/missed trip; today's trips use the
// job's ON CONFLICT (schedule_id, trip_date) DO NOTHING.
import crypto from 'node:crypto';
import sharp from 'sharp';
import type { SchoolSettingsDto } from '@wimb/shared';
import { raiseAlert } from '../../modules/alerts/service.js';
import { buildPath } from '../../modules/routes/path.js';
import { loadSchoolSettings } from '../../modules/school/index.js';
import { generateTripsForDate, missedAfterMin } from '../../modules/trips/jobs.js';
import { gapVerdict, gpsMismatchAlert } from '../../modules/trips/odometer.js';
import { storage } from '../../shared/storage.js';
import type { SeedContext } from '../seed.js';
import type { Tx } from '../tenant.js';
import { DEMO_ROUTES } from './50_routes.js';

const HISTORY_DAYS = 5;
const DEFAULT_ODOMETER = 24_000;

interface SeedTrip extends Record<string, unknown> {
  id: string;
  bus_id: string;
  bus_code: string;
  direction: 'morning' | 'afternoon';
  trip_date: string;
  planned_start_at: string;
  driver_staff_id: string | null;
  conductor_staff_id: string | null;
  driver_user_id: string | null;
  route_km: number | null;
  route_minutes: number | null;
  last_known: number | null;
  /** School location. */
  lat: number | null;
  lng: number | null;
  /** First / last live stop of the trip's route (sequence order), when it has stops. */
  first_stop_lat?: number | null;
  first_stop_lng?: number | null;
  last_stop_lat?: number | null;
  last_stop_lng?: number | null;
}

interface Position {
  lat: number;
  lng: number;
}

type Outcome = 'completed' | 'gap' | 'mismatch' | 'auto_closed' | 'missed';

interface Planned {
  trip: SeedTrip;
  outcome: Outcome;
  start: number | null;
  end: number | null;
  gpsKm: number | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Where the start / end reading was taken (null without that reading). */
  startPos?: Position | null;
  endPos?: Position | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const addMinutes = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

/** Deterministic GPS jitter of a few metres (≈ 5–25 m) so seeded positions are not exactly on the stop. */
export function jitter(pos: Position, k: number): Position {
  const r = 0.00005 + (Math.abs(Math.sin(k * 12.9898)) % 1) * 0.00017;
  const a = k * 2.399963; // golden angle
  return { lat: Math.round((pos.lat + r * Math.sin(a)) * 1e7) / 1e7, lng: Math.round((pos.lng + r * Math.cos(a)) * 1e7) / 1e7 };
}

/**
 * Where a school trip starts and ends: the endpoints of the route's planned path (morning: first stop →
 * school; afternoon: school → last stop). Falls back to the school when the route has no stops.
 */
export function tripEndpoints(t: Pick<SeedTrip, 'direction' | 'lat' | 'lng' | 'first_stop_lat' | 'first_stop_lng' | 'last_stop_lat' | 'last_stop_lng'>): { start: Position | null; end: Position | null } {
  const school = t.lat !== null && t.lng !== null ? { latitude: Number(t.lat), longitude: Number(t.lng) } : null;
  const stops: { id: string; latitude: number; longitude: number }[] = [];
  if (t.first_stop_lat != null && t.first_stop_lng != null) stops.push({ id: 'first', latitude: Number(t.first_stop_lat), longitude: Number(t.first_stop_lng) });
  if (t.last_stop_lat != null && t.last_stop_lng != null) stops.push({ id: 'last', latitude: Number(t.last_stop_lat), longitude: Number(t.last_stop_lng) });
  const points = buildPath(t.direction, stops, school).points;
  if (!points.length) {
    const at = school && { lat: school.latitude, lng: school.longitude };
    return { start: at, end: at };
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return { start: { lat: first.lat, lng: first.lng }, end: { lat: last.lat, lng: last.lng } };
}

/** Last `n` school days (Mon–Sat) before `today`, oldest first. */
function pastSchoolDays(today: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${today}T00:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() !== 0) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}

function outcomeOf(t: SeedTrip, dayIndex: number, days: number): Outcome {
  const ago = days - dayIndex; // 1 = yesterday
  if (t.bus_code === 'R2' && t.direction === 'morning' && ago === 3) return 'gap';
  if (t.bus_code === 'R1' && t.direction === 'morning' && ago === 2) return 'mismatch';
  if (t.bus_code === 'R1' && t.direction === 'afternoon' && ago === 4) return 'auto_closed';
  if (t.bus_code === 'R2' && t.direction === 'afternoon' && ago === 1) return 'missed';
  return 'completed';
}

/** Continuous readings per bus, shifted so the last reading equals the bus's last known odometer. */
function plan(trips: SeedTrip[], days: string[]): Planned[] {
  const out: Planned[] = [];
  const byBus = new Map<string, SeedTrip[]>();
  for (const t of trips) byBus.set(t.bus_id, [...(byBus.get(t.bus_id) ?? []), t]);
  for (const list of byBus.values()) {
    let reading = 0;
    const planned: Planned[] = list.map((t, i) => {
      const outcome = outcomeOf(t, days.indexOf(t.trip_date), days.length);
      const ends = tripEndpoints(t);
      const startPos = ends.start && jitter(ends.start, i * 2 + 1);
      const endPos = ends.end && jitter(ends.end, i * 2 + 2);
      if (outcome === 'missed') return { trip: t, outcome, start: null, end: null, gpsKm: null, startedAt: null, endedAt: null };
      const km = round1((t.route_km ?? 12) + ((i * 7) % 10) / 10);
      const gap = outcome === 'gap' ? 18.4 : round1(((i * 3) % 9) / 10 + 0.4);
      const start = round1(reading + gap);
      reading = round1(start + km);
      const startedAt = addMinutes(t.planned_start_at, (i * 5) % 7);
      const minutes = t.route_minutes ?? 40;
      if (outcome === 'auto_closed') return { trip: t, outcome, start, end: null, gpsKm: round1(km * 0.45), startedAt, endedAt: addMinutes(startedAt, Math.round(minutes / 2)), startPos, endPos: null };
      return { trip: t, outcome, start, end: reading, gpsKm: round1(km * (outcome === 'mismatch' ? 0.55 : 0.97)), startedAt, endedAt: addMinutes(startedAt, minutes + ((i * 3) % 6)), startPos, endPos };
    });
    const last = list[0]!.last_known ?? DEFAULT_ODOMETER;
    const shift = round1(last - reading);
    for (const p of planned) {
      if (p.start !== null) p.start = round1(p.start + shift);
      if (p.end !== null) p.end = round1(p.end + shift);
      out.push(p);
    }
  }
  return out;
}

async function odometerJpeg(reading: number, label: string): Promise<Buffer> {
  const digits = reading.toFixed(1).padStart(8, '0');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
    <rect width="480" height="320" fill="#1d232a"/><rect x="40" y="100" width="400" height="110" rx="10" fill="#0b0f12" stroke="#5f6b76" stroke-width="4"/>
    <text x="240" y="178" font-family="monospace" font-size="64" fill="#f2f5f7" text-anchor="middle">${digits}</text>
    <text x="240" y="245" font-family="sans-serif" font-size="22" fill="#9aa7b2" text-anchor="middle">km · ${label}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer();
}

async function evidence(tx: Tx, schoolId: string, p: Planned, kind: 'start' | 'end'): Promise<void> {
  const reading = kind === 'start' ? p.start! : p.end!;
  const at = kind === 'start' ? p.startedAt! : p.endedAt!;
  const body = await odometerJpeg(reading, `Bus ${p.trip.bus_code} ${kind} ${at.slice(0, 16).replace('T', ' ')} UTC`);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const key = storage.schoolObjectKey({ schoolId, category: 'odometer', entityId: p.trip.id, extension: 'jpg' });
  await storage.putObject({ key, body, contentType: 'image/jpeg', checksum: sha256 });
  const pos = kind === 'start' ? p.startPos : p.endPos;
  const lat = pos ? pos.lat : (p.trip.lat ?? null);
  const lng = pos ? pos.lng : (p.trip.lng ?? null);
  const capture = { capturedAt: at, latitude: lat, longitude: lng, accuracyM: 6, source: 'camera' };
  const file = await tx.one<{ id: string }>(
    `insert into files (school_id, key, category, entity_type, entity_id, mime, size_bytes, sha256, original_name, metadata, status, uploaded_by, uploader_type)
     values ($1, $2, 'odometer', 'trip', $3, 'image/jpeg', $4, $5, $6, $7::jsonb, 'uploaded', $8, 'user') returning id`,
    [schoolId, key, p.trip.id, body.length, sha256, `odometer-${kind}.jpg`, JSON.stringify({ capture, seeded: true }), p.trip.driver_user_id],
  );
  await tx.query(
    `insert into trip_odometer_evidence (school_id, trip_id, kind, reading, file_id, captured_at, received_at, latitude, longitude, accuracy_m, sha256, source, recorded_by)
     values ($1, $2, $3, $4, $5, $6, $6, $7, $8, 6, $9, 'camera', $10)`,
    [schoolId, p.trip.id, kind, reading, file.id, at, lat, lng, sha256, p.trip.driver_user_id],
  );
}

/**
 * Alerts of one seeded trip, decided by the real rules (BP §10.3 rules 3–4) with the school's thresholds, so
 * the demo data matches what the engine would have raised: the start reading against the previous closed
 * trip's end (odometer_gap / odometer_decrease — including the gap after the auto-closed trip, whose distance
 * was never recorded), the odometer ↔ GPS comparison, plus the auto-close and not-started alerts.
 */
async function alertsFor(tx: Tx, p: Planned, previousEnd: number | null, settings: SchoolSettingsDto): Promise<number> {
  const t = p.trip;
  const base = { tripId: t.id, busId: t.bus_id, staffId: t.driver_staff_id, entity: { type: 'trip' as const, id: t.id }, once: true };
  const raised = [];
  if (p.start !== null && previousEnd !== null) {
    const v = gapVerdict(p.start, previousEnd, settings.odometerMismatchThresholdKm);
    if (v.kind === 'gap') {
      raised.push(await raiseAlert(tx, { ...base, type: 'odometer_gap', severity: v.severity, title: `Bus ${t.bus_code}: unexplained odometer gap of ${v.gapKm} km (possible unrecorded use)`, details: { reading: p.start, previousEndOdometer: previousEnd, gapKm: v.gapKm, thresholdKm: settings.odometerMismatchThresholdKm }, dedupeKey: `odometer_gap:${t.id}` }));
    } else if (v.kind === 'decrease') {
      raised.push(await raiseAlert(tx, { ...base, type: 'odometer_decrease', severity: 'critical', title: `Bus ${t.bus_code}: odometer decreased (tampering suspected)`, details: { phase: 'start', reading: p.start, previousEndOdometer: previousEnd }, dedupeKey: `odometer_decrease:${t.id}:start` }));
    }
  }
  if (p.start !== null && p.end !== null) {
    raised.push(await gpsMismatchAlert(tx, { id: t.id, bus_id: t.bus_id, bus_code_snapshot: t.bus_code, driver_staff_id: t.driver_staff_id, start_odometer: p.start, end_odometer: p.end, distance_gps_km: p.gpsKm }, settings));
  }
  if (p.outcome === 'auto_closed') {
    raised.push(await raiseAlert(tx, { ...base, type: 'trip_auto_closed', severity: 'warning', title: `Bus ${t.bus_code}: trip closed automatically (no location data for ${settings.effective.staleTripCloseHours} h)`, details: { startedAt: p.startedAt, staleHours: settings.effective.staleTripCloseHours, startOdometer: p.start, gpsKm: p.gpsKm }, dedupeKey: `trip_auto_closed:${t.id}` }));
  }
  if (p.outcome === 'missed') {
    raised.push(await raiseAlert(tx, { ...base, type: 'trip_not_started', severity: 'warning', title: `Bus ${t.bus_code} ${t.direction} trip has not started`, details: { plannedStartAt: t.planned_start_at, graceMin: settings.tripNotStartedGraceMin, tripDate: t.trip_date }, dedupeKey: `trip_not_started:${t.id}` }));
  }
  return raised.filter((a) => a !== null).length;
}

async function nonSchoolTrip(tx: Tx, schoolId: string, yesterday: string): Promise<boolean> {
  const bus = await tx.maybeOne<{ id: string; code: string; registration_no: string; last_known: number | null; driver_id: string | null; driver_name: string | null; driver_user_id: string | null; lat: number | null; lng: number | null; started_at: string }>(
    `select b.id, b.code, b.registration_no, b.last_known_odometer as last_known, sp.id as driver_id, sp.full_name as driver_name, sp.user_id as driver_user_id,
            s.latitude as lat, s.longitude as lng, (($2::date + time '17:30') at time zone s.timezone) as started_at
       from buses b join schools s on s.id = b.school_id
       left join lateral (select sp.* from bus_staff_assignments a join staff_profiles sp on sp.id = a.staff_id
                           where a.bus_id = b.id and a.assignment_role = 'primary_driver' and a.valid_to is null limit 1) sp on true
      where b.school_id = $1 and b.code = 'R1' and b.deleted_at is null`,
    [schoolId, yesterday],
  );
  if (!bus) return false;
  const start = round1((bus.last_known ?? DEFAULT_ODOMETER) + 1.2);
  const end = round1(start + 14.6);
  const startedAt = new Date(bus.started_at).toISOString();
  const endedAt = addMinutes(startedAt, 55);
  const trip = await tx.one<SeedTrip>(
    `insert into trips (school_id, trip_type, trip_date, bus_id, driver_staff_id, bus_code_snapshot, bus_registration_snapshot, driver_name_snapshot,
                        status, started_at, ended_at, closed_at, start_device_time, end_device_time, start_lat, start_lng, end_lat, end_lng, start_odometer, end_odometer,
                        distance_odometer_km, distance_gps_km, purpose, started_by, ended_by)
     values ($1, 'non_school', $2, $3, $4, $5, $6, $7, 'completed', $8, $9, $9, $8, $9, $10, $11, $10, $11, $12, $13, $14, $15, 'Service at the authorised workshop', $16, $16)
     returning id, bus_id, $5::text as bus_code, $4::uuid as driver_staff_id, $16::uuid as driver_user_id, $10::numeric as lat, $11::numeric as lng`,
    [schoolId, yesterday, bus.id, bus.driver_id, bus.code, bus.registration_no, bus.driver_name, startedAt, endedAt, bus.lat, bus.lng, start, end, round1(end - start), 14.1, bus.driver_user_id],
  );
  const atSchool = bus.lat !== null && bus.lng !== null ? { lat: Number(bus.lat), lng: Number(bus.lng) } : null;
  const p: Planned = {
    trip: { ...trip, direction: 'morning', trip_date: yesterday, planned_start_at: startedAt, conductor_staff_id: null, route_km: null, route_minutes: null, last_known: null },
    outcome: 'completed', start, end, gpsKm: 14.1, startedAt, endedAt, startPos: atSchool, endPos: atSchool,
  };
  await evidence(tx, schoolId, p, 'start');
  await evidence(tx, schoolId, p, 'end');
  await raiseAlert(tx, {
    type: 'non_school_trip', severity: 'info', title: `Bus ${bus.code}: non-school trip (${round1(end - start)} km) — Service at the authorised workshop`,
    entity: { type: 'trip', id: trip.id }, tripId: trip.id, busId: bus.id, staffId: bus.driver_id, details: { purpose: 'Service at the authorised workshop', distanceOdometerKm: round1(end - start) },
    dedupeKey: `non_school_trip:${trip.id}`, once: true,
  });
  await tx.query('update buses set last_known_odometer = $2, odometer_updated_at = $3 where id = $1', [bus.id, end, endedAt]);
  return true;
}

async function seedHistory(tx: Tx, schoolId: string, today: string): Promise<{ trips: number; alerts: number }> {
  const settings = await loadSchoolSettings(tx);
  const days = pastSchoolDays(today, HISTORY_DAYS);
  for (const day of days) await generateTripsForDate(tx, day);
  const trips = await tx.many<SeedTrip>(
    `select t.id, t.bus_id, t.bus_code_snapshot as bus_code, t.direction, t.trip_date::text as trip_date, t.planned_start_at, t.driver_staff_id, t.conductor_staff_id,
            sp.user_id as driver_user_id, round(r.distance_m / 1000.0, 1)::float8 as route_km, round(r.duration_s / 60.0)::int as route_minutes,
            b.last_known_odometer as last_known, s.latitude::float8 as lat, s.longitude::float8 as lng,
            fs.latitude::float8 as first_stop_lat, fs.longitude::float8 as first_stop_lng, ls.latitude::float8 as last_stop_lat, ls.longitude::float8 as last_stop_lng
       from trips t join buses b on b.id = t.bus_id join schools s on s.id = t.school_id
       left join routes r on r.id = t.route_id left join staff_profiles sp on sp.id = t.driver_staff_id
       left join lateral (select st.latitude, st.longitude from stops st where st.route_id = t.route_id and st.deleted_at is null order by st.sequence limit 1) fs on true
       left join lateral (select st.latitude, st.longitude from stops st where st.route_id = t.route_id and st.deleted_at is null order by st.sequence desc limit 1) ls on true
      where t.school_id = $1 and t.trip_date = any ($2::date[]) and t.status = 'scheduled' and t.schedule_id is not null
      order by t.bus_id, t.planned_start_at`,
    [schoolId, days],
  );
  const planned = plan(trips, days);
  const started = planned.filter((p) => p.outcome !== 'missed');
  const status = (p: Planned) => (p.outcome === 'missed' ? 'missed' : p.outcome === 'auto_closed' ? 'auto_closed' : 'completed');
  const missedMin = missedAfterMin(settings.tripNotStartedGraceMin);
  const staleHours = settings.effective.staleTripCloseHours;
  const reason = (p: Planned) =>
    p.outcome === 'missed'
      ? `Not started within ${missedMin} minutes of the planned start`
      : p.outcome === 'auto_closed'
        ? `No location data for ${staleHours} hour${staleHours === 1 ? '' : 's'}: closed automatically`
        : null;
  await tx.query(
    `update trips t set status = x.status, started_at = x.started_at, ended_at = x.ended_at, start_device_time = x.started_at, end_device_time = case when x.end_o is null then null else x.ended_at end,
            start_odometer = x.start_o, end_odometer = x.end_o, distance_odometer_km = x.end_o - x.start_o, distance_gps_km = x.gps,
            close_reason = x.reason,
            closed_at = case x.status when 'completed' then x.ended_at when 'auto_closed' then x.ended_at + make_interval(hours => $9) else null end,
            started_by = case when x.start_o is null then null else (select sp.user_id from staff_profiles sp where sp.id = t.driver_staff_id) end,
            ended_by = case when x.end_o is null then null else (select sp.user_id from staff_profiles sp where sp.id = t.driver_staff_id) end,
            start_lat = case when x.start_o is null then null else x.start_lat end, start_lng = case when x.start_o is null then null else x.start_lng end,
            end_lat = case when x.end_o is null then null else x.end_lat end, end_lng = case when x.end_o is null then null else x.end_lng end, updated_at = now()
       from unnest($1::uuid[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::numeric[], $6::numeric[], $7::numeric[], $8::text[],
                   $10::float8[], $11::float8[], $12::float8[], $13::float8[])
              as x(id, status, started_at, ended_at, start_o, end_o, gps, reason, start_lat, start_lng, end_lat, end_lng)
      where t.id = x.id`,
    [
      planned.map((p) => p.trip.id), planned.map(status), planned.map((p) => p.startedAt), planned.map((p) => p.endedAt),
      planned.map((p) => p.start), planned.map((p) => p.end), planned.map((p) => p.gpsKm), planned.map(reason), staleHours,
      planned.map((p) => p.startPos?.lat ?? null), planned.map((p) => p.startPos?.lng ?? null),
      planned.map((p) => p.endPos?.lat ?? null), planned.map((p) => p.endPos?.lng ?? null),
    ],
  );
  let alerts = 0;
  const lastEnd = new Map<string, number>();
  for (const p of planned) {
    if (p.start !== null) await evidence(tx, schoolId, p, 'start');
    if (p.end !== null) await evidence(tx, schoolId, p, 'end');
    alerts += await alertsFor(tx, p, lastEnd.get(p.trip.bus_id) ?? null, settings);
    if (p.end !== null) lastEnd.set(p.trip.bus_id, p.end);
  }
  const nonSchool = await nonSchoolTrip(tx, schoolId, days[days.length - 1]!);
  return { trips: started.length + planned.filter((p) => p.outcome === 'missed').length + (nonSchool ? 1 : 0), alerts: alerts + (nonSchool ? 1 : 0) };
}

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger } = ctx;
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });
  const schools = await tx.many<{ id: string; code: string }>('select id, code from schools where code = any ($1) and deleted_at is null order by code', [DEMO_ROUTES.map((s) => s.code)]);
  const summary: Record<string, { history: number; alerts: number; today: number }> = {};
  for (const school of schools) {
    await ctx.setContext({ schoolId: school.id, actorId: null, role: 'system' });
    const today = (await tx.one<{ d: string }>('select app_local_date()::text as d')).d;
    const hasHistory = await tx.maybeOne(`select 1 from trips where school_id = $1 and status in ('completed', 'auto_closed', 'missed') limit 1`, [school.id]);
    const history = hasHistory ? { trips: 0, alerts: 0 } : await seedHistory(tx, school.id, today);
    const todays = await generateTripsForDate(tx, today);
    summary[school.code] = { history: history.trips, alerts: history.alerts, today: todays.length };
  }
  logger.info({ summary }, 'Trips seed applied');
}
