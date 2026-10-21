// 'parent' module router (BP §8.5, contract §4). Mounted at /api/v1 by src/modules/index.ts. The /parent
// area guard authenticates every request as a parent; per-child routes add guards.parent(), which
// validates X-School-Id against an active child link (parent_children_index) and sets the tenant
// context of that school. GET /parent/children, POST /parent/devices and the inbox span schools and
// need no X-School-Id. Parents are strictly read-only on school data (BP §15.3): the only writes are
// their own notification preferences, devices and inbox read markers.
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { guards } from '../../middleware/guards.js';
import { validate } from '../../shared/validate.js';
import { fileUrlQuery } from '../files/schemas.js';
import * as c from './controller.js';
import * as s from './schemas.js';
import { markTenantSchoolUsed } from './schools.js';
import './sockets.js';

export const router: Router = Router();

const parentAny = [authenticate(), authorize('parent')];
// Per-child routes resolve X-School-Id, then record that the parent uses that school (migration 854).
const child = [...guards.parent(), markTenantSchoolUsed];

router.get('/parent/children', ...parentAny, c.children);
router.get('/parent/children/:studentId/tracking', ...child, validate({ params: s.parentStudentParams, query: s.parentTrackingQuery }), c.tracking);
router.get('/parent/children/:studentId/bus', ...child, validate({ params: s.parentStudentParams, query: s.parentTrackingQuery }), c.bus);
router.get('/parent/children/:studentId/staff', ...child, validate({ params: s.parentStudentParams, query: s.parentTrackingQuery }), c.staff);
router.get('/parent/children/:studentId/notification-preferences', ...child, validate({ params: s.parentStudentParams }), c.preferences);
router.put('/parent/children/:studentId/notification-preferences', ...child, validate({ params: s.parentStudentParams, body: s.notificationPreferencesBody }), c.updatePreferences);
router.get('/parent/files/:fileId/url', ...child, validate({ params: s.parentFileParams, query: fileUrlQuery }), c.fileUrl);
router.post('/parent/devices', ...parentAny, validate({ body: s.parentDeviceBody }), c.device);
router.get('/parent/notifications', ...parentAny, validate({ query: s.parentNotificationsQuery }), c.notifications);
router.post('/parent/notifications/read-all', ...parentAny, c.readAllNotifications);
router.post('/parent/notifications/:id/read', ...parentAny, validate({ params: s.parentNotificationParams }), c.readNotification);

export default router;
