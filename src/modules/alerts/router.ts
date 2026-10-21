// 'alerts' module router (BP §8.3 Alerts, §11.1, §13.3). Mounted at /api/v1 by src/modules/index.ts.
// API: docs/api/alerts.md.
//   GET   /school/alerts        inbox list (filters, sort, page, counts per status, format=csv)
//   GET   /school/alerts/:id    one alert
//   PATCH /school/alerts/:id    review (note) · escalate (notifies alert recipients) · close
// The admin bell room school:{id}:alerts is built into src/socket.ts (school admins of that school);
// new alerts reach it as alert:new (service.announceAlerts), status changes as alert:updated.
import { Router } from 'express';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { validate } from '../../shared/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';

export function createAlertsRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const admin = createGuards(guardOptions).schoolAdmin();
  const params = validate({ params: s.alertParams });
  r.get('/school/alerts', ...admin, validate({ query: s.alertListQuery }), c.list);
  r.get('/school/alerts/:id', ...admin, params, c.get);
  r.patch('/school/alerts/:id', ...admin, params, validate({ body: s.alertActionBody }), c.act);
  return r;
}

export const router: Router = createAlertsRouter();
export default router;
