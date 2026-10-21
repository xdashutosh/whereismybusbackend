// Static module registry (BP §7.1, contract §15). Each module owns src/modules/<name>/ and exposes
// a router mounted at /api/v1 that declares full sub-paths ('/auth/school/login',
// '/school/buses/:id', '/driver/trips/start', …). Order only matters for overlapping paths.
import { API_PREFIX } from '@wimb/shared';
import { Router } from 'express';
import { areaGuards } from '../middleware/guards.js';
import { router as alerts } from './alerts/router.js';
import { router as audit } from './audit/router.js';
import { router as auth } from './auth/router.js';
import { router as buses } from './buses/router.js';
import { router as files } from './files/router.js';
import { router as fuel } from './fuel/router.js';
import { router as maintenance } from './maintenance/router.js';
import { router as notifications } from './notifications/router.js';
import { router as parent } from './parent/router.js';
import { router as platform } from './platform/router.js';
import { router as privacy } from './privacy/router.js';
import { router as reports } from './reports/router.js';
import { router as routes } from './routes/router.js';
import { router as school } from './school/router.js';
import { router as staff } from './staff/router.js';
import { router as students } from './students/router.js';
import { router as tracking } from './tracking/router.js';
import { router as trips } from './trips/router.js';
import { router as users } from './users/router.js';

export { API_PREFIX };

export interface ModuleEntry {
  name: string;
  router: Router;
}

/** Every module in mount order. */
export const modules: readonly ModuleEntry[] = Object.freeze([
  { name: 'auth', router: auth },
  { name: 'platform', router: platform },
  { name: 'school', router: school },
  { name: 'users', router: users },
  { name: 'staff', router: staff },
  { name: 'buses', router: buses },
  { name: 'routes', router: routes },
  { name: 'students', router: students },
  { name: 'trips', router: trips },
  { name: 'tracking', router: tracking },
  { name: 'alerts', router: alerts },
  { name: 'fuel', router: fuel },
  { name: 'maintenance', router: maintenance },
  { name: 'reports', router: reports },
  { name: 'parent', router: parent },
  { name: 'files', router: files },
  { name: 'notifications', router: notifications },
  { name: 'audit', router: audit },
  { name: 'privacy', router: privacy },
]);

/**
 * One router holding every module router (mounted by app.ts at API_PREFIX). Area guards
 * (middleware/guards.ts) run first for /platform, /school, /driver and /parent paths.
 */
export function buildApiRouter(entries: readonly ModuleEntry[] = modules): Router {
  const api = Router();
  for (const [prefix, handlers] of areaGuards()) api.use(prefix, ...handlers);
  for (const m of entries) api.use(m.router);
  return api;
}
