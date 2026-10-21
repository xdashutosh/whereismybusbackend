// 'trips' module router (BP §8.4 driver/conductor API, §10 trip lifecycle, §13.3 Trips & Audit).
// Mounted at /api/v1 by src/modules/index.ts. API: docs/api/trips.md.
//   GET  /driver/me · GET /driver/home · POST /driver/devices
//   POST /driver/trips/start · GET /driver/trips/active · GET /driver/trips/history
//   POST /driver/trips/:id/end · POST /driver/trips/:id/events · POST /driver/trips/:id/interrupt
//   GET  /school/trips · GET /school/trips/:id
//   POST /school/trips/:id/cancel · POST /school/trips/:id/correct-odometer · POST /school/trips/:id/reassign
// Trip and device endpoints of drivers/conductors mount requireBoundDevice() after the staff guard
// (X-Device-Id of the phone the session is bound to); trip actions also compare it with trips.device_id.
import { Router } from 'express';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { validate } from '../../shared/validate.js';
import { requireBoundDevice } from '../auth/index.js';
import * as c from './controller.js';
import * as s from './schemas.js';

registerConstraintError('one_active_trip_per_driver', 'TRIP_ALREADY_ACTIVE', 'This driver already has a trip in progress.');
registerConstraintError('one_active_trip_per_conductor', 'TRIP_ALREADY_ACTIVE', 'This conductor already has a trip in progress.');
registerConstraintError('trip_odometer_evidence_one_per_kind', 'CONFLICT', 'This trip already has an odometer reading of this kind.');

export function createTripsRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const g = createGuards(guardOptions);
  const staff = [...g.staff(), requireBoundDevice()];
  const admin = g.schoolAdmin();
  const trip = validate({ params: s.tripParams });

  r.get('/driver/me', ...staff, c.me);
  r.get('/driver/home', ...staff, c.home);
  r.post('/driver/devices', ...staff, validate({ body: s.driverDeviceBody }), c.device);
  r.post('/driver/trips/start', ...staff, validate({ body: s.startTripBody }), c.start);
  r.get('/driver/trips/active', ...staff, c.active);
  r.get('/driver/trips/history', ...staff, validate({ query: s.driverTripHistoryQuery }), c.history);
  r.post('/driver/trips/:id/end', ...staff, trip, validate({ body: s.endTripBody }), c.end);
  r.post('/driver/trips/:id/events', ...staff, trip, validate({ body: s.tripEventsBody }), c.events);
  r.post('/driver/trips/:id/interrupt', ...staff, trip, validate({ body: s.interruptTripBody }), c.interrupt);

  r.get('/school/trips', ...admin, validate({ query: s.tripListQuery }), c.list);
  r.get('/school/trips/:id', ...admin, trip, c.get);
  r.post('/school/trips/:id/cancel', ...admin, trip, validate({ body: s.cancelTripBody }), c.cancel);
  r.post('/school/trips/:id/correct-odometer', ...admin, trip, validate({ body: s.correctOdometerBody }), c.correctOdometer);
  r.post('/school/trips/:id/reassign', ...admin, trip, validate({ body: s.reassignTripBody }), c.reassign);
  return r;
}

export const router: Router = createTripsRouter();
export default router;
