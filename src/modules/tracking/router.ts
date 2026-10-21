// 'tracking' module router (BP §9, §8.3 live fleet, §8.6). Mounted at /api/v1. API: docs/api/tracking.md.
//   POST /driver/trips/:id/locations   batch ingestion (driver/conductor of the trip, bound device)
//   GET  /driver/trips/:id/route       planned route + stops + own live state (driver app map)
//   GET  /school/fleet/live            every bus with its live position/status/crew/trip
//   GET  /school/trips/:id/path        planned polyline, actual simplified path, stop events, summary
// Socket rooms (./sockets.ts) and the jobs (./jobs.ts) register themselves on import.
import { Router } from 'express';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { createLimiter } from '../../middleware/rateLimits.js';
import { validate } from '../../shared/validate.js';
import { requireBoundDevice } from '../auth/index.js';
import * as c from './controller.js';
import * as s from './schemas.js';
import './lifecycle.js';
import './sockets.js';

/** Per-session ceiling on ingestion requests (the 10-s floor drops excess points anyway). */
export const ingestLimiter = createLimiter({ name: 'location-ingest', limit: 120, windowSec: 60, key: (req) => req.auth?.sessionId ?? null, message: 'Too many location uploads. Please slow down.' });

export function createTrackingRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const g = createGuards(guardOptions);
  const trip = validate({ params: s.tripParams });

  r.post('/driver/trips/:id/locations', ...g.staff(), requireBoundDevice(), ingestLimiter, trip, validate({ body: s.ingestBody }), c.ingest);
  r.get('/driver/trips/:id/route', ...g.staff(), requireBoundDevice(), trip, c.driverTripRoute);
  r.get('/school/fleet/live', ...g.schoolAdmin(), c.fleetLive);
  r.get('/school/trips/:id/path', ...g.schoolAdmin(), trip, validate({ query: s.pathQuery }), c.tripPath);
  return r;
}

export const router: Router = createTrackingRouter();
export default router;
