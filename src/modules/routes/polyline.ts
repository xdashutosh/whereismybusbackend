// Planned route polylines (contract §2 Routing, client constraint §0.3). The path runs through the live
// stops in sequence order; the school (when its location is set) is the destination of a morning route
// and the origin of an afternoon route, unless the last/first stop already lies within
// SCHOOL_ENDPOINT_MERGE_M of it. shared/routing.computeRoute() calls Google Routes (stops as
// intermediates) when GOOGLE_MAPS_SERVER_KEY is set and falls back to a flagged straight line otherwise,
// so the source switches to 'google' automatically once the key is configured and the API enabled.
//
// The provider call never runs inside a database transaction (PgBouncer, contract §3): phase 1 reads
// the points, the route is computed, phase 2 locks the route and stores the result only if the points
// are still the same (a concurrent stop edit triggers its own recompute).
import type { RecomputePolylineResult, RoutingLeg } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { computeRoute, type ComputedRoute, type RoutingOptions } from '../../shared/routing.js';
import type { RouteRow } from './dto.js';
import { buildPath, type RoutePath } from './path.js';
import * as repo from './repository.js';
import * as stopsRepo from './stopsRepository.js';

const log = rootLogger.child({ module: 'routes.polyline' });

export { buildPath, type PathPoint, type RoutePath } from './path.js';

/** Loads the current path of a locked or unlocked route inside `tx`. */
export async function loadPath(tx: Tx, route: Pick<RouteRow, 'id' | 'direction'>): Promise<RoutePath> {
  const stops = await stopsRepo.listStops(tx, route.id);
  return buildPath(route.direction, stops, await repo.schoolLocation(tx));
}

let routingOptions: RoutingOptions = {};
/** Test seam: provider options (API key, fetch) for computeRoute; returns a restore function. */
export function useRoutingOptions(opts: RoutingOptions): () => void {
  const previous = routingOptions;
  routingOptions = opts;
  return () => {
    routingOptions = previous;
  };
}

export type RecomputeTrigger = 'manual' | 'stops_changed';

export interface RecomputeOutcome {
  applied: boolean;
  path: RoutePath;
  computed: ComputedRoute | null;
}

function legsOf(path: RoutePath, computed: ComputedRoute): RoutingLeg[] {
  return computed.legs.map((l, i) => ({ fromStopId: path.points[i]?.stopId ?? null, toStopId: path.points[i + 1]?.stopId ?? null, distanceM: l.distanceM, durationS: l.durationS }));
}

export function routingSummary(outcome: RecomputeOutcome): RecomputePolylineResult['routing'] | null {
  const c = outcome.computed;
  if (!c) return null;
  return {
    source: c.source,
    fallbackReason: c.fallbackReason ?? null,
    distanceM: c.distanceM,
    durationS: c.durationS,
    includesSchool: outcome.path.includesSchool,
    legs: legsOf(outcome.path, c),
  };
}

/**
 * Recomputes and stores a route's planned path. Fewer than two points clear it. Returns
 * applied = false when the stops changed while the provider was being called (nothing stored).
 * Throws NOT_FOUND (via `onMissing`) when the route is gone.
 */
export async function recomputePolyline(req: Request, routeId: string, trigger: RecomputeTrigger, onMissing: () => Error): Promise<RecomputeOutcome> {
  const before = await withRequestTenant(
    req,
    async (tx) => {
      const route = await repo.findRoute(tx, routeId);
      return route ? loadPath(tx, route) : null;
    },
    { readOnly: true },
  );
  if (!before) throw onMissing();
  const computed = before.points.length >= 2 ? await computeRoute(before.points, routingOptions) : null;
  const applied = await withRequestTenant(req, async (tx) => {
    const route = await repo.lockRoute(tx, routeId);
    if (!route) throw onMissing();
    const now = await loadPath(tx, route);
    if (now.fingerprint !== before.fingerprint) return false;
    const next = computed
      ? { polyline: computed.polyline, source: computed.source, distanceM: computed.distanceM, durationS: computed.durationS }
      : { polyline: null, source: null, distanceM: null, durationS: null };
    if (!computed && route.polyline_encoded === null && trigger !== 'manual') return true;
    await repo.savePolyline(tx, routeId, next);
    await audit.log(tx, {
      action: 'route.polyline_recompute',
      entityType: 'route',
      entityId: routeId,
      old: { polylineSource: route.polyline_source, distanceM: route.distance_m, durationS: route.duration_s },
      new: { polylineSource: next.source, distanceM: next.distanceM, durationS: next.durationS, points: now.points.length, trigger, fallbackReason: computed?.fallbackReason ?? null },
    });
    return true;
  });
  return { applied, path: before, computed };
}

/** Best-effort recompute after a committed stop change: failures are logged, never thrown. */
export async function refreshAfterStopChange(req: Request, routeId: string): Promise<void> {
  try {
    const outcome = await recomputePolyline(req, routeId, 'stops_changed', () => new Error('Route not found'));
    if (!outcome.applied) log.info({ routeId, schoolId: req.tenant?.schoolId }, 'Stops changed during polyline computation; the newer change recomputes it');
  } catch (err) {
    log.warn({ err: { message: (err as Error).message }, routeId, schoolId: req.tenant?.schoolId }, 'Planned path refresh after a stop change failed');
  }
}
