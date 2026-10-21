// Keeps the live state in step with events owned by the trips module:
//   trip.status_changed      when a trip leaves in_progress (completed, cancelled, auto-closed) its live
//                            state records the new status, so live views and parent snapshots stop showing
//                            it as running before the finalizer removes it.
//   trip.location_permission the driver app lost the location permission (denied): the trip becomes
//                            "Location unavailable" at once (live:status to the fleet and trip rooms, parent
//                            reason LOCATION_PERMISSION_DENIED, tracking.location_unavailable) instead of
//                            waiting for the gap detector; restored: the flag is cleared and the next fix
//                            clears "Location unavailable" (ingest). A denial older than the newest live fix
//                            is stale (the fixes prove the permission is back) and ignored. A running trip
//                            without fixes yet (no live state, no last_point_at) gets a fresh live state.
import type { TripStatusPayload } from '../trips/events.js';
import { withSchoolSystem } from '../../db/tenant.js';
import { events, type AppEvents } from '../../shared/events.js';
import { trackingConfig } from './config.js';
import { liveStore, newLiveState } from './liveState.js';
import { emitStatus } from './publish.js';
import './events.js';

export async function onTripStatusChanged(p: Pick<TripStatusPayload, 'schoolId' | 'tripId' | 'status'>): Promise<void> {
  if (p.status === 'in_progress') return;
  await liveStore.withLock(p.schoolId, p.tripId, async () => {
    const state = await liveStore.get(p.schoolId, p.tripId);
    if (!state || state.tripStatus === p.status) return;
    state.tripStatus = p.status;
    await liveStore.put(state);
  });
}

export type LocationPermissionChange = AppEvents['trip.location_permission'];

/** Applies a location-permission change to the live state of a running trip. Returns true when it changed. */
export async function onLocationPermission(p: LocationPermissionChange, nowMs = Date.now()): Promise<boolean> {
  const atMs = Date.parse(p.at);
  const changed = await liveStore.withLock(p.schoolId, p.tripId, async () => {
    const stored = await liveStore.get(p.schoolId, p.tripId);
    // Without fixes there are no stop visits to restore, so a fresh state is safe (ingest seeds them otherwise).
    const state =
      stored ??
      (p.state === 'denied' && p.busId && !p.lastPointAt
        ? newLiveState({ schoolId: p.schoolId, tripId: p.tripId, busId: p.busId, routeId: p.routeId ?? null, direction: p.direction ?? null, tripStatus: 'in_progress', lastPointAt: null })
        : null);
    if (!state || state.tripStatus !== 'in_progress') return null;
    if (p.state === 'denied') {
      if (state.lastLiveAtMs !== null && Number.isFinite(atMs) && state.lastLiveAtMs > atMs) return null;
      if ((state.locationPermissionDeniedAtMs ?? null) !== null) return null;
      state.locationPermissionDeniedAtMs = Number.isFinite(atMs) ? atMs : nowMs;
      const wasUnavailable = state.locationUnavailable;
      state.locationUnavailable = true;
      await liveStore.put(state);
      return { state, wasUnavailable };
    }
    if ((state.locationPermissionDeniedAtMs ?? null) === null) return null;
    state.locationPermissionDeniedAtMs = null;
    await liveStore.put(state);
    return null;
  });
  if (!changed) return false;
  const cfg = await withSchoolSystem(p.schoolId, (tx) => trackingConfig(tx), { readOnly: true });
  await emitStatus(changed.state, cfg, 'location_unavailable', {}, nowMs);
  if (!changed.wasUnavailable) {
    const lastPointAt = changed.state.point?.t ?? null;
    events.emit('tracking.location_unavailable', { schoolId: p.schoolId, tripId: p.tripId, busId: changed.state.busId, lastPointAt });
  }
  return true;
}

events.on('trip.status_changed', onTripStatusChanged);
events.on('trip.location_permission', async (p) => {
  await onLocationPermission(p);
});
