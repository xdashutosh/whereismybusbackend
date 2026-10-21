// Events of the tracking module (emitted AFTER commit through shared/events, in the process that
// ran the analytics — the worker in production). The notifications module subscribes to them for
// the parent notifications of BP §11.2 (bus left school, approaching stop, arrived at stop, trip
// delayed). Payloads always carry school_id (BP §16).
import type { Direction, TripEta } from '@wimb/shared';

export interface TrackingStopEvent {
  schoolId: string;
  tripId: string;
  busId: string;
  routeId: string | null;
  direction: Direction | null;
  stopId: string | null;
  /** null stop id = the school geofence (bus left / reached school). */
  at: string;
}

declare module '../../shared/events.js' {
  interface AppEvents {
    /** The bus entered a stop geofence (first entry per trip and stop). */
    'tracking.stop_arrived': TrackingStopEvent & { stopId: string; distanceM: number };
    /** The bus left a stop geofence (dwell recorded). */
    'tracking.stop_departed': TrackingStopEvent & { stopId: string; dwellS: number };
    /** The bus left the school geofence (morning: after the last stop is passed; afternoon: first departure). */
    'tracking.left_school': TrackingStopEvent;
    /** A new ETA was computed for a running trip (quality-gated; see TripEta.quality). */
    'tracking.eta_updated': { schoolId: string; tripId: string; busId: string; routeId: string | null; direction: Direction | null; eta: TripEta };
    /** The gap detector flagged the trip as "Location unavailable" / points resumed. */
    'tracking.location_unavailable': { schoolId: string; tripId: string; busId: string; lastPointAt: string | null };
    'tracking.location_restored': { schoolId: string; tripId: string; busId: string; at: string };
  }
}

export {};
