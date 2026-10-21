// 'school' module router (BP §8.3 Profile/Settings, §13.3 Settings; contract §9). Mounted at
// /api/v1 by src/modules/index.ts. School admins only (the /school area guard runs first; every
// route also declares guards.schoolAdmin()). API reference: docs/api/school.md.
//   GET/PATCH  /school/profile
//   GET/PUT    /school/settings
//   GET/PUT    /school/settings/parent-visibility
//   CRUD       /school/holidays
//   CRUD       /school/announcements
import {
  createAnnouncementBody,
  createHolidayBody,
  parentVisibilityBody,
  schoolSettingsBody,
  updateAnnouncementBody,
  updateHolidayBody,
} from '@wimb/shared';
import { Router } from 'express';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { idempotency } from '../../middleware/idempotency.js';
import { validate } from '../../shared/validate.js';
import * as c from './controller.js';
import './events.js';
import { announcementListQuery, holidayListQuery, idParams, updateProfileBody } from './schemas.js';

export function createSchoolRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const admin = createGuards(guardOptions).schoolAdmin();

  r.get('/school/profile', ...admin, c.getProfile);
  r.patch('/school/profile', ...admin, validate({ body: updateProfileBody }), c.updateProfile);

  r.get('/school/settings', ...admin, c.getSettings);
  r.put('/school/settings', ...admin, validate({ body: schoolSettingsBody }), c.updateSettings);
  r.get('/school/settings/parent-visibility', ...admin, c.getParentVisibility);
  r.put('/school/settings/parent-visibility', ...admin, validate({ body: parentVisibilityBody }), c.updateParentVisibility);

  r.get('/school/holidays', ...admin, validate({ query: holidayListQuery }), c.listHolidays);
  r.post('/school/holidays', ...admin, validate({ body: createHolidayBody }), idempotency(), c.createHoliday);
  r.get('/school/holidays/:id', ...admin, validate({ params: idParams }), c.getHoliday);
  r.patch('/school/holidays/:id', ...admin, validate({ params: idParams, body: updateHolidayBody }), c.updateHoliday);
  r.delete('/school/holidays/:id', ...admin, validate({ params: idParams }), c.deleteHoliday);

  r.get('/school/announcements', ...admin, validate({ query: announcementListQuery }), c.listAnnouncements);
  r.post('/school/announcements', ...admin, validate({ body: createAnnouncementBody }), idempotency(), c.createAnnouncement);
  r.get('/school/announcements/:id', ...admin, validate({ params: idParams }), c.getAnnouncement);
  r.patch('/school/announcements/:id', ...admin, validate({ params: idParams, body: updateAnnouncementBody }), c.updateAnnouncement);
  r.delete('/school/announcements/:id', ...admin, validate({ params: idParams }), c.deleteAnnouncement);
  return r;
}

export const router: Router = createSchoolRouter();
export default router;
