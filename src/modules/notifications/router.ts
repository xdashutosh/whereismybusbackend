// 'notifications' module router (BP §11.2; contract §2, §9). Mounted at /api/v1 by
// src/modules/index.ts. API: docs/api/notifications.md.
//   GET /school/notifications   the school's parent notification log (filters, sort, format=csv)
// The engine itself has no public endpoint: it reacts to trip/tracking/announcement events
// (./listeners.ts, registered here for the API process and through ./jobs.ts for the worker) and
// works in the 'notifications-dispatch' / 'announcement-deliver' jobs. Parent-facing endpoints
// (notification preferences, devices, inbox) live in the parent module.
import { Router } from 'express';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { validate } from '../../shared/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';
import './listeners.js';

export function createNotificationsRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const g = createGuards(guardOptions);
  r.get('/school/notifications', ...g.schoolAdmin(), validate({ query: s.schoolNotificationListQuery }), c.list);
  return r;
}

export const router: Router = createNotificationsRouter();
export default router;
