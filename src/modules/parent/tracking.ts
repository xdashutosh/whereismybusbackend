// GET /parent/children/:studentId/tracking (BP §8.5, §9.3, §9.4, §15.2 Track Bus): one snapshot for
// the map — the BP §9.4 status for THIS child's stop (tracking.parentStatus), the newest received
// position and its time ("Last updated"), the quality-gated ETA to the child's stop and the next stop,
// the planned polyline of the child's route with its stops, and the child's stop + school markers.
// Only for a parent whose linked child has a CURRENT assignment (the trip shown is today's trip of
// that bus + direction). Live data comes from the kv live state (cheap, BP §9.2); the app then joins
// child:{studentId}:live and polls this endpoint no faster than pollAfterS (10 s moving / 60 s
// stopped) as the fallback.
import type { Direction, ParentTrackingSnapshot, TripLiveState } from '@wimb/shared';
import type { Request } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { encodePolyline } from '../../shared/geo.js';
import { rooms } from '../../shared/realtime.js';
import { buildPath } from '../routes/index.js';
import { getLiveState, NO_TRIP_PHASE, trackingConfig } from '../tracking/index.js';
import { assignmentFor, loadChild } from './access.js';
import * as repo from './repository.js';
import { childStatus, etaFor, firstName, liveFor, pollAfterS, positionOf, statusTrip, stopRef } from './view.js';

function plannedOf(direction: Direction, geo: repo.RouteGeometryRow | null, school: { lat: number | null; lng: number | null }): ParentTrackingSnapshot['planned'] {
  const stops = (geo?.stops ?? []).map((s) => ({ id: s.id, sequence: s.sequence, name: s.name, lat: Number(s.latitude), lng: Number(s.longitude) }));
  if (geo?.polyline_encoded) return { polyline: geo.polyline_encoded, polylineSource: geo.polyline_source, stops };
  // No stored polyline yet: the flagged straight line through the stops (and the school), as the
  // tracking module does for ETA.
  const schoolPoint = school.lat !== null && school.lng !== null ? { latitude: school.lat, longitude: school.lng } : null;
  const path = buildPath(direction, (geo?.stops ?? []).map((s) => ({ id: s.id, latitude: s.latitude, longitude: s.longitude })), schoolPoint);
  return path.points.length >= 2 ? { polyline: encodePolyline(path.points.map((p) => ({ lat: p.lat, lng: p.lng }))), polylineSource: 'straight', stops } : { polyline: null, polylineSource: null, stops };
}

export async function trackingSnapshot(req: Request, studentId: string, direction?: Direction): Promise<ParentTrackingSnapshot> {
  const nowMs = Date.now();
  const { child, row, brand, cfg, live, geo } = await withRequestTenant(req, async (tx) => {
    const c = await loadChild(tx, studentId);
    const r = assignmentFor(c, direction);
    const b = await repo.schoolBrand(tx);
    const config = await trackingConfig(tx);
    const l: TripLiveState | null = r.trip_id && r.trip_status === 'in_progress' ? await getLiveState(tx, r.trip_id) : null;
    return { child: c, row: r, brand: b, cfg: config, live: l, geo: await repo.routeGeometry(tx, r.route_id) };
  });
  const school = { id: brand?.id ?? req.tenant!.schoolId, name: brand?.name ?? '', lat: brand?.latitude ?? null, lng: brand?.longitude ?? null };
  const tripLive = liveFor(row.trip_status, live);
  const status =
    row.trip_id && row.trip_status
      ? childStatus(statusTrip({ ...row, trip_status: row.trip_status }), tripLive, { stopId: row.stop_id, plannedAt: row.stop_planned_at }, cfg, nowMs)
      : {
          // No trip today for this bus and direction (holiday, no schedule or not generated yet).
          status: 'not_started' as const,
          reason: 'NO_TRIP_TODAY',
          etaAt: null,
          etaMinutes: null,
          plannedAt: row.next_at,
          delayMin: null,
          lastUpdatedAt: null,
          stopPassed: false,
          ...NO_TRIP_PHASE,
        };
  return {
    serverTime: new Date(nowMs).toISOString(),
    studentId: child.studentId,
    firstName: firstName(child.fullName),
    school,
    direction: row.direction,
    bus: { id: row.bus_id, code: row.bus_code },
    route: { id: row.route_id, code: row.route_code, name: row.route_name },
    stop: { ...stopRef(row), arrivalRadiusM: row.stop_radius_m },
    trip:
      row.trip_id && row.trip_status && row.trip_date
        ? { id: row.trip_id, status: row.trip_status, tripDate: row.trip_date, plannedStartAt: row.planned_start_at, startedAt: row.started_at, endedAt: row.ended_at }
        : null,
    status,
    position: positionOf(tripLive),
    motion: tripLive?.motion ?? null,
    freshness: tripLive?.freshness ?? 'none',
    lastUpdatedAt: tripLive?.point?.t ?? null,
    eta: etaFor(tripLive, row.stop_id),
    planned: plannedOf(row.direction, geo, school),
    room: rooms.childLive(child.studentId),
    pollAfterS: pollAfterS(row.trip_status, tripLive),
  };
}
