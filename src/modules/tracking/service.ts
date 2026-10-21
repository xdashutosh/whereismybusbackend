// Read services of the tracking module: live fleet (BP §8.3), trip path (planned vs actual + stop
// events) and the driver's planned route. Live data comes from the kv live state, history from
// location_points / trips.summary.
import type { DriverTripRouteResponse, FleetBusStatus, FleetLiveItem, FleetLiveResponse, LivePoint, PathStop, TripLiveState, TripPathResponse } from '@wimb/shared';
import type { Request } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { forbidden, notFound, unauthenticated } from '../../shared/errors.js';
import { trackingConfig, type TrackingConfig } from './config.js';
import { simplifiedPath } from './finalizer.js';
import * as fleetRepo from './fleetRepository.js';
import { buildGeometry, type TripGeometry } from './geometry.js';
import { liveStore, toPublicLive } from './liveState.js';
import * as repo from './repository.js';
import type { PathQuery } from './schemas.js';
import { filterTrack } from './track.js';

/** Raw points returned by ?includePoints=true (evenly sampled above this). */
export const MAX_RAW_POINTS = 5000;

function fleetStatus(row: fleetRepo.FleetRow, live: TripLiveState | null): FleetBusStatus {
  if (row.trip_id) {
    if (!live || !live.point) return live?.locationUnavailable ? 'location_unavailable' : 'awaiting_location';
    if (live.locationUnavailable || live.freshness !== 'live') return 'location_unavailable';
    return live.motion === 'stopped' ? 'stopped' : 'moving';
  }
  if (row.bus_status === 'maintenance') return 'maintenance';
  if (row.bus_status === 'inactive' || row.bus_status === 'retired') return 'inactive';
  return 'idle';
}

export async function fleetLive(req: Request): Promise<FleetLiveResponse> {
  if (!req.tenant) throw unauthenticated();
  const schoolId = req.tenant.schoolId;
  const { rows, cfg } = await withRequestTenant(req, async (tx) => ({ rows: await fleetRepo.fleet(tx, req.tenant!.timezone), cfg: await trackingConfig(tx) }));
  const tripIds = rows.map((r) => r.trip_id).filter((id): id is string => id !== null);
  const states = await liveStore.getMany(schoolId, tripIds);
  const nowMs = Date.now();
  const buses: FleetLiveItem[] = rows.map((r) => {
    const stored = r.trip_id ? states.get(r.trip_id) : undefined;
    const live = stored ? toPublicLive({ ...stored, tripStatus: r.trip_status ?? stored.tripStatus }, cfg, nowMs) : null;
    return {
      busId: r.bus_id,
      busCode: r.bus_code,
      displayName: r.display_name,
      registrationNo: r.registration_no,
      busStatus: r.bus_status,
      status: fleetStatus(r, live),
      driver: r.trip_id ? (r.trip_driver ?? r.driver) : r.driver,
      conductor: r.trip_id ? (r.trip_conductor ?? r.conductor) : r.conductor,
      activeTrip: r.trip_id
        ? {
            id: r.trip_id,
            tripType: r.trip_type!,
            direction: r.direction,
            status: r.trip_status!,
            routeId: r.route_id,
            routeCode: r.route_code,
            routeName: r.route_name,
            startedAt: r.started_at,
            plannedStartAt: r.planned_start_at,
            pointsCount: Number(r.points_count ?? 0),
          }
        : null,
      live,
      nextTrip: r.trip_id ? null : r.next_trip,
      lastKnown: r.trip_id ? null : r.last_known,
    };
  });
  const count = (s: FleetBusStatus) => buses.filter((b) => b.status === s).length;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    summary: {
      total: buses.length,
      onTrip: buses.filter((b) => b.activeTrip).length,
      moving: count('moving'),
      stopped: count('stopped'),
      locationUnavailable: count('location_unavailable'),
      idle: count('idle'),
    },
    buses,
  };
}

function toPathStops(g: TripGeometry | null): PathStop[] {
  return (g?.stops ?? []).map((s) => ({ id: s.id, sequence: s.sequence, name: s.name, lat: s.lat, lng: s.lng, expectedTime: s.expectedTime, arrivalRadiusM: s.radiusM }));
}

function sample<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) out.push(items[Math.floor(i * step)]!);
  out[out.length - 1] = items[items.length - 1]!;
  return out;
}

async function liveOf(schoolId: string, tripId: string, cfg: TrackingConfig, status: TripLiveState['tripStatus']): Promise<TripLiveState | null> {
  if (status !== 'in_progress') return null;
  const s = await liveStore.get(schoolId, tripId);
  return s ? toPublicLive({ ...s, tripStatus: status }, cfg) : null;
}

export async function tripPath(req: Request, tripId: string, q: PathQuery): Promise<TripPathResponse> {
  if (!req.tenant) throw unauthenticated();
  const schoolId = req.tenant.schoolId;
  return withRequestTenant(req, async (tx) => {
    const trip = await fleetRepo.pathTrip(tx, tripId);
    if (!trip) throw notFound('Trip not found.');
    const cfg = await trackingConfig(tx);
    const geoRow = await repo.tripGeometry(tx, tripId);
    const geometry = geoRow ? buildGeometry(geoRow) : null;
    const events = await repo.stopEvents(tx, tripId);
    const stored = (trip.summary as { path?: { encoded?: string | null; pointCount?: number; retainedAt?: string }; points?: { total?: number } } | null) ?? null;
    let actual: TripPathResponse['actual'];
    let rawPoints: repo.StoredPointRow[] | null = null;
    // Finalized trips, and trips whose path was kept before the location purge (tracking/retention.ts).
    if (stored?.path && (trip.finalized_at || stored.path.retainedAt)) {
      actual = {
        polyline: stored.path.encoded ?? null,
        pointCount: Number(stored.points?.total ?? 0),
        simplifiedPointCount: Number(stored.path.pointCount ?? 0),
        start: trip.first_point,
        end: trip.last_point,
        source: stored.path.encoded ? 'finalizer' : 'none',
      };
    } else {
      rawPoints = await repo.tripPoints(tx, tripId, { from: trip.started_at, to: trip.ended_at });
      const { kept } = filterTrack(rawPoints.map((r) => ({ ms: Date.parse(r.recorded_at), lat: Number(r.latitude), lng: Number(r.longitude), acc: r.accuracy_m === null ? null : Number(r.accuracy_m), spd: r.speed_kmh })));
      const path = await simplifiedPath(tx, kept);
      actual = { polyline: path.encoded, pointCount: rawPoints.length, simplifiedPointCount: path.pointCount, start: trip.first_point, end: trip.last_point, source: path.encoded ? 'computed' : 'none' };
    }
    const response: TripPathResponse = {
      trip: {
        id: trip.id,
        status: trip.status,
        tripType: trip.trip_type,
        direction: trip.direction,
        tripDate: trip.trip_date,
        busId: trip.bus_id,
        busCode: trip.bus_code,
        routeId: trip.route_id,
        routeCode: trip.route_code,
        routeName: trip.route_name,
        startedAt: trip.started_at,
        endedAt: trip.ended_at,
        distanceGpsKm: trip.distance_gps_km,
        distanceOdometerKm: trip.distance_odometer_km,
        finalizedAt: trip.finalized_at,
      },
      planned: { polyline: geometry?.encoded ?? null, polylineSource: geometry?.source ?? null, stops: toPathStops(geometry), school: geometry?.school ?? null },
      actual,
      stopEvents: events.map((e) => ({ stopId: e.stop_id, stopName: e.stop_name, sequence: e.sequence, arrivedAt: e.arrived_at, departedAt: e.departed_at, dwellS: e.dwell_s, distanceM: e.distance_m, source: e.source })),
      summary: trip.summary,
      live: await liveOf(schoolId, tripId, cfg, trip.status),
    };
    if (q.includePoints) {
      rawPoints ??= await repo.tripPoints(tx, tripId, { from: trip.started_at, to: trip.ended_at });
      response.points = sample(rawPoints, MAX_RAW_POINTS).map(
        (r): LivePoint => ({ t: r.recorded_at, lat: Number(r.latitude), lng: Number(r.longitude), spd: r.speed_kmh, hdg: r.heading, acc: r.accuracy_m, bat: r.battery_pct, net: r.network_type, mv: r.is_moving }),
      );
    }
    return response;
  });
}

/** Planned route of the caller's own trip (driver app active-trip map; simulator). */
export async function driverTripRoute(req: Request, tripId: string): Promise<DriverTripRouteResponse> {
  const auth = req.auth;
  if (!auth || !req.tenant) throw unauthenticated();
  const schoolId = req.tenant.schoolId;
  return withRequestTenant(req, async (tx) => {
    const trip = await repo.ingestTrip(tx, tripId, auth.actorId);
    if (!trip) throw notFound('Trip not found.');
    if (!trip.is_crew) throw forbidden('This trip is not assigned to you.');
    const cfg = await trackingConfig(tx);
    const geoRow = await repo.tripGeometry(tx, tripId);
    const geometry = geoRow ? buildGeometry(geoRow) : null;
    return {
      tripId,
      routeId: trip.route_id,
      polyline: geometry?.encoded ?? null,
      polylineSource: geometry?.source ?? null,
      stops: toPathStops(geometry),
      school: geometry?.school ?? null,
      live: await liveOf(schoolId, tripId, cfg, trip.status),
    };
  });
}
