// HTTP layer of the parent module: read req.valid, call the service, send the envelope.
import type { NotificationPreferencesBody, ParentDeviceBody, ParentNotificationsQuery, ParentTrackingQuery } from '@wimb/shared';
import type { Request, Response } from 'express';
import { list as sendList, ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import type { FileUrlQuery } from '../files/schemas.js';
import { listChildren } from './children.js';
import { busDetails, parentFileUrl, staffCards } from './details.js';
import { registerDevice } from './devices.js';
import { listNotifications, markAllRead, markRead } from './inbox.js';
import { getPreferences, putPreferences } from './preferences.js';
import { trackingSnapshot } from './tracking.js';

const studentIdOf = (req: Request) => validated<{ studentId: string }>(req, 'params').studentId;

export async function children(req: Request, res: Response) {
  ok(res, await listChildren(req));
}

export async function tracking(req: Request, res: Response) {
  ok(res, await trackingSnapshot(req, studentIdOf(req), validated<ParentTrackingQuery>(req, 'query').direction));
}

export async function bus(req: Request, res: Response) {
  ok(res, await busDetails(req, studentIdOf(req), validated<ParentTrackingQuery>(req, 'query').direction));
}

export async function staff(req: Request, res: Response) {
  ok(res, await staffCards(req, studentIdOf(req), validated<ParentTrackingQuery>(req, 'query').direction));
}

export async function fileUrl(req: Request, res: Response) {
  ok(res, await parentFileUrl(req, validated<{ fileId: string }>(req, 'params').fileId, validated<FileUrlQuery>(req, 'query')));
}

export async function preferences(req: Request, res: Response) {
  ok(res, await getPreferences(req, studentIdOf(req)));
}

export async function updatePreferences(req: Request, res: Response) {
  ok(res, await putPreferences(req, studentIdOf(req), validated<NotificationPreferencesBody>(req, 'body')));
}

export async function device(req: Request, res: Response) {
  ok(res, await registerDevice(req, validated<ParentDeviceBody>(req, 'body')));
}

export async function notifications(req: Request, res: Response) {
  const { items, meta } = await listNotifications(req, validated<ParentNotificationsQuery>(req, 'query'));
  sendList(res, items, meta);
}

export async function readNotification(req: Request, res: Response) {
  ok(res, await markRead(req, validated<{ id: string }>(req, 'params').id));
}

export async function readAllNotifications(req: Request, res: Response) {
  ok(res, await markAllRead(req));
}
