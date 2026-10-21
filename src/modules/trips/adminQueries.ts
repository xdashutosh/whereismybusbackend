// School admin reads (BP §13.3 Trips & Audit): GET /school/trips (filters, sort, page, CSV) and
// GET /school/trips/:id (snapshots, odometer start/end with evidence photo URLs, distances, flags,
// stop events, planned route). One query per list; the detail reads its parts in one READ ONLY
// transaction and signs evidence URLs after it.
import type { OdometerCorrection, OdometerEvidenceDto, TripDetail, TripFlag, TripDetailStopEvent, TripListItem, TripListQuery } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { notFound } from '../../shared/errors.js';
import { escapeLike, listMeta, MAX_EXPORT_ROWS, pagedQuery, parsePagination, parseSort } from '../../shared/pagination.js';
import { sendPdf, type PdfColumn } from '../../shared/pdf.js';
import { storage } from '../../shared/storage.js';
import { optionalSignedUrl } from '../files/urls.js';
import { listStops, toStopDto } from '../routes/index.js';
import { schoolContext } from './context.js';
import { toListItem, type TripListRow } from './dto.js';
import { TRIP_COLUMNS } from './repository.js';
import { loadTimeline } from './timeline.js';

const SORT = {
  allowed: {
    tripDate: 't.trip_date',
    plannedStartAt: 't.planned_start_at',
    startedAt: 't.started_at',
    endedAt: 't.ended_at',
    status: 't.status',
    busCode: 't.bus_code_snapshot',
    routeCode: 't.route_code_snapshot',
    driverName: 't.driver_name_snapshot',
    distanceOdometerKm: 't.distance_odometer_km',
    distanceGpsKm: 't.distance_gps_km',
    createdAt: 't.created_at',
  },
  defaultSort: '-tripDate,plannedStartAt',
  tiebreaker: 't.id',
};

const LIST_SELECT = `${TRIP_COLUMNS}, coalesce(al.alert_count, 0) as alert_count, coalesce(al.open_alert_count, 0) as open_alert_count, al.alert_types`;
const LIST_FROM = `from trips t
  left join lateral (
    select count(*)::int as alert_count,
           (count(*) filter (where a.status in ('open', 'escalated')))::int as open_alert_count,
           array_agg(distinct a.alert_type order by a.alert_type) as alert_types
      from alerts a where a.trip_id = t.id
  ) al on true`;

function where(q: TripListQuery) {
  return {
    sql: `($1::date is null or t.trip_date >= $1::date) and ($2::date is null or t.trip_date <= $2::date)
      and ($3::uuid is null or t.bus_id = $3::uuid) and ($4::uuid is null or t.route_id = $4::uuid)
      and ($5::uuid is null or t.driver_staff_id = $5::uuid) and ($6::uuid is null or t.conductor_staff_id = $6::uuid)
      and ($7::text[] is null or t.trip_type = any ($7::text[])) and ($8::text[] is null or t.status = any ($8::text[]))
      and ($9::text[] is null or t.direction = any ($9::text[]))
      and ($10::boolean is null or (coalesce(al.alert_count, 0) > 0) = $10::boolean)
      and ($11::text is null or concat_ws(' ', t.bus_code_snapshot, t.bus_registration_snapshot, t.route_code_snapshot, t.route_name_snapshot,
                                          t.driver_name_snapshot, t.conductor_name_snapshot, t.purpose) ilike '%' || $11 || '%')`,
    params: [
      q.from ?? null, q.to ?? null, q.busId ?? null, q.routeId ?? null, q.driverId ?? null, q.conductorId ?? null,
      q.type ?? null, q.status ?? null, q.direction ?? null, q.flagged ?? null, q.q ? escapeLike(q.q) : null,
    ],
  };
}

const CSV_COLUMNS: CsvColumn<TripListItem>[] = [
  { header: 'Date', key: 'tripDate' },
  { header: 'Type', key: 'tripType' },
  { header: 'Direction', key: 'direction' },
  { header: 'Status', key: 'status' },
  { header: 'Bus', key: 'busCode' },
  { header: 'Registration', key: 'busRegistrationNo' },
  { header: 'Route', key: 'routeCode' },
  { header: 'Route name', key: 'routeName' },
  { header: 'Driver', key: 'driverName' },
  { header: 'Conductor', key: 'conductorName' },
  { header: 'Purpose', key: 'purpose' },
  { header: 'Planned start (UTC)', key: 'plannedStartAt' },
  { header: 'Started (UTC)', key: 'startedAt' },
  { header: 'Ended (UTC)', key: 'endedAt' },
  { header: 'Start odometer (km)', key: 'startOdometer' },
  { header: 'End odometer (km)', key: 'endOdometer' },
  { header: 'Odometer distance (km)', key: 'distanceOdometerKm' },
  { header: 'GPS distance (km)', key: 'distanceGpsKm' },
  { header: 'Odometer corrected', value: (r) => (r.odometerCorrected ? 'yes' : 'no') },
  { header: 'Interrupted', value: (r) => (r.interrupted ? 'yes' : 'no') },
  { header: 'Alerts', value: (r) => r.alertTypes.join(' ') },
];

/** 'YYYY-MM-DD HH:mm' in the school's timezone ('' for null). */
function localTime(iso: string | null, timezone: string): string {
  if (!iso) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}`;
}

const label = (s: string | null) => (s ? (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, ' ') : '');
const km = (v: number | null) => (v === null ? '' : v.toFixed(1));

function pdfColumns(timezone: string): PdfColumn<TripListItem>[] {
  return [
    { header: 'Date', width: 1.1, value: (r) => r.tripDate },
    { header: 'Type / direction', width: 1.3, value: (r) => (r.tripType === 'non_school' ? 'Non-school' : label(r.direction)) },
    { header: 'Status', width: 1.1, value: (r) => label(r.status) + (r.interrupted ? ' (interrupted)' : '') },
    { header: 'Bus', width: 1.2, value: (r) => [r.busCode, r.busRegistrationNo].filter(Boolean).join(' · ') },
    { header: 'Route', width: 1.6, value: (r) => (r.routeCode ? `${r.routeCode} ${r.routeName ?? ''}`.trim() : (r.purpose ?? '')) },
    { header: 'Driver / conductor', width: 1.7, value: (r) => [r.driverName, r.conductorName].filter(Boolean).join(' / ') },
    { header: `Started (${timezone})`, width: 1.3, value: (r) => localTime(r.startedAt, timezone) },
    { header: `Ended (${timezone})`, width: 1.3, value: (r) => localTime(r.endedAt, timezone) },
    { header: 'Odometer km', width: 0.9, align: 'right', value: (r) => km(r.distanceOdometerKm) + (r.odometerCorrected ? '*' : '') },
    { header: 'GPS km', width: 0.8, align: 'right', value: (r) => km(r.distanceGpsKm) },
    { header: 'Alerts', width: 1.4, value: (r) => r.alertTypes.map(label).join(', ') },
  ];
}

/** GET /school/trips — JSON page, CSV export or printable PDF. */
export async function list(req: Request, res: Response, q: TripListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, SORT);
  const w = where(q);
  if (q.format === 'csv' || q.format === 'pdf') {
    const rows = await withRequestTenant(req, (tx) => tx.many<TripListRow>(`select ${LIST_SELECT} ${LIST_FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params), { readOnly: true });
    if (q.format === 'pdf') {
      const timezone = req.tenant?.timezone ?? 'Asia/Kolkata';
      const period = q.from || q.to ? `Trip dates ${q.from ?? '…'} – ${q.to ?? '…'}` : 'All trip dates';
      await sendPdf(res, 'trips.pdf', {
        title: 'Trips',
        meta: [period, `${rows.length} trip(s)${rows.length >= MAX_EXPORT_ROWS ? ' (first ' + MAX_EXPORT_ROWS + ')' : ''}`, `Generated ${localTime(new Date().toISOString(), timezone)} (${timezone})`, '* odometer corrected'],
        columns: pdfColumns(timezone),
        rows: rows.map(toListItem),
        landscape: true,
      });
      return;
    }
    const csv = createCsvWriter<TripListItem>(res, { fileName: 'trips.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toListItem));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(
    req,
    (tx) => pagedQuery<TripListRow>(tx, { select: LIST_SELECT, from: LIST_FROM, where: w.sql, params: w.params, orderBy, limit, offset }),
    { readOnly: true },
  );
  sendList(res, rows.map((r) => toListItem(r as TripListRow)), listMeta({ page, limit, total }));
}

interface DetailRow extends TripListRow {
  started_by_name: string | null;
  ended_by_name: string | null;
  cancelled_by_name: string | null;
}

interface EvidenceRow extends Record<string, unknown> {
  id: string;
  kind: 'start' | 'end' | 'place';
  reading: number | null;
  file_id: string;
  captured_at: string;
  received_at: string;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  sha256: string | null;
  source: 'camera' | 'gallery';
  device_id: string | null;
  recorded_by: string | null;
  recorded_by_name: string | null;
  file_key: string | null;
  thumb_key: string | null;
}

async function loadDetail(tx: Tx, id: string) {
  const trip = await tx.maybeOne<DetailRow>(
    `select ${LIST_SELECT},
            (select full_name from users where id = t.started_by) as started_by_name,
            (select full_name from users where id = t.ended_by) as ended_by_name,
            (select full_name from users where id = t.cancelled_by) as cancelled_by_name
       ${LIST_FROM} where t.id = $1`,
    [id],
  );
  if (!trip) return null;
  const evidence = await tx.many<EvidenceRow>(
    `select e.id, e.kind, e.reading, e.file_id, e.captured_at, e.received_at, e.latitude, e.longitude, e.accuracy_m, e.sha256, e.source,
            e.device_id, e.recorded_by, u.full_name as recorded_by_name,
            case when f.status = 'uploaded' then f.key end as file_key, case when f.status = 'uploaded' then f.thumb_key end as thumb_key
       from trip_odometer_evidence e join files f on f.id = e.file_id left join users u on u.id = e.recorded_by
      where e.trip_id = $1
      order by array_position(array['start', 'end', 'place'], e.kind), e.received_at`,
    [id],
  );
  const flags = await tx.many<{ id: string; alert_type: TripFlag['type']; severity: TripFlag['severity']; status: TripFlag['status']; title: string; created_at: string }>(
    'select id, alert_type, severity, status, title, created_at from alerts where trip_id = $1 order by created_at, id',
    [id],
  );
  const stopEvents = await tx.many<Record<string, unknown>>(
    `select se.stop_id, s.name as stop_name, s.sequence, s.expected_time, se.arrived_at, se.departed_at, se.dwell_s, se.distance_m, se.source
       from trip_stop_events se join stops s on s.id = se.stop_id
      where se.trip_id = $1 order by s.sequence, se.arrived_at`,
    [id],
  );
  const route = trip.route_id
    ? await tx.maybeOne<{ id: string; code: string; name: string | null; direction: 'morning' | 'afternoon'; polyline_encoded: string | null; polyline_source: 'google' | 'straight' | null }>(
        'select id, code, name, direction, polyline_encoded, polyline_source from routes where id = $1',
        [trip.route_id],
      )
    : null;
  const stops = route ? await listStops(tx, route.id) : [];
  const timeline = await loadTimeline(tx, id);
  return { trip, evidence, flags, stopEvents, route, stops, timeline };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const person = (id: string | null, name: string | null) => (id ? { id, name } : null);

/** GET /school/trips/:id */
export async function detail(req: Request, id: string): Promise<TripDetail> {
  const { schoolId } = schoolContext(req);
  const d = await withRequestTenant(req, (tx) => loadDetail(tx, id), { readOnly: true });
  if (!d) throw notFound('Trip not found.');
  const own = (key: string | null) => (key && storage.schoolIdOfKey(key) === schoolId ? key : null);
  const evidence: OdometerEvidenceDto[] = await Promise.all(
    d.evidence.map(async (e) => ({
      id: e.id,
      kind: e.kind,
      reading: num(e.reading),
      fileId: e.file_id,
      photoUrl: await optionalSignedUrl(req, own(e.file_key)),
      thumbnailUrl: await optionalSignedUrl(req, own(e.thumb_key)),
      capturedAt: e.captured_at,
      receivedAt: e.received_at,
      latitude: num(e.latitude),
      longitude: num(e.longitude),
      accuracyM: num(e.accuracy_m),
      sha256: e.sha256,
      source: e.source,
      deviceId: e.device_id,
      recordedBy: e.recorded_by,
      recordedByName: e.recorded_by_name,
    })),
  );
  const t = d.trip;
  const stopEvents: TripDetailStopEvent[] = d.stopEvents.map((s) => ({
    stopId: s.stop_id as string,
    stopName: s.stop_name as string,
    sequence: Number(s.sequence),
    expectedTime: typeof s.expected_time === 'string' ? s.expected_time.slice(0, 5) : null,
    arrivedAt: (s.arrived_at as string | null) ?? null,
    departedAt: (s.departed_at as string | null) ?? null,
    dwellS: num(s.dwell_s),
    distanceM: num(s.distance_m),
    source: s.source as TripDetailStopEvent['source'],
  }));
  return {
    ...toListItem(t),
    scheduleId: t.schedule_id,
    startDeviceTime: t.start_device_time,
    endDeviceTime: t.end_device_time,
    start: { latitude: num(t.start_lat), longitude: num(t.start_lng) },
    end: { latitude: num(t.end_lat), longitude: num(t.end_lng) },
    deviceId: t.device_id,
    startedBy: person(t.started_by, t.started_by_name),
    endedBy: person(t.ended_by, t.ended_by_name),
    cancelledBy: person(t.cancelled_by, t.cancelled_by_name),
    cancelReason: t.cancel_reason,
    closeReason: t.close_reason,
    interruptedAt: t.interrupted_at,
    lastPointAt: t.last_point_at,
    pointsCount: Number(t.points_count ?? 0),
    odometerCorrection: (t.odometer_correction as OdometerCorrection | null) ?? null,
    evidence,
    flags: d.flags.map((f) => ({ id: f.id, type: f.alert_type, severity: f.severity, status: f.status, title: f.title, createdAt: f.created_at })),
    stopEvents,
    timeline: d.timeline,
    route: d.route
      ? { id: d.route.id, code: d.route.code, name: d.route.name, direction: d.route.direction, polyline: d.route.polyline_encoded, polylineSource: d.route.polyline_source, stops: d.stops.map(toStopDto) }
      : null,
    summary: t.summary,
    finalizedAt: t.finalized_at,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}
