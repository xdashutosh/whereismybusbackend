// HTTP layer of the school module: reads req.valid, calls the services, sends envelopes.
import type {
  CreateAnnouncementBody,
  CreateHolidayBody,
  ParentVisibilityBody,
  SchoolSettingsBody,
  UpdateAnnouncementBody,
  UpdateHolidayBody,
} from '@wimb/shared';
import type { Request, Response } from 'express';
import { created, ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import * as announcements from './announcements.js';
import * as holidays from './holidays.js';
import * as profile from './profile.js';
import type { AnnouncementListQuery, HolidayListQuery, IdParams, UpdateProfileBody } from './schemas.js';
import * as settings from './settings.js';

const idOf = (req: Request) => validated<IdParams>(req, 'params').id;

// profile
export async function getProfile(req: Request, res: Response) {
  ok(res, await profile.getProfile(req));
}
export async function updateProfile(req: Request, res: Response) {
  ok(res, await profile.updateProfile(req, validated<UpdateProfileBody>(req, 'body')));
}

// settings
export async function getSettings(req: Request, res: Response) {
  ok(res, await settings.getSettings(req));
}
export async function updateSettings(req: Request, res: Response) {
  ok(res, await settings.updateSettings(req, validated<SchoolSettingsBody>(req, 'body')));
}
export async function getParentVisibility(req: Request, res: Response) {
  ok(res, await settings.getParentVisibility(req));
}
export async function updateParentVisibility(req: Request, res: Response) {
  ok(res, await settings.updateParentVisibility(req, validated<ParentVisibilityBody>(req, 'body')));
}

// holidays
export async function listHolidays(req: Request, res: Response) {
  await holidays.list(req, res, validated<HolidayListQuery>(req, 'query'));
}
export async function getHoliday(req: Request, res: Response) {
  ok(res, await holidays.get(req, idOf(req)));
}
export async function createHoliday(req: Request, res: Response) {
  created(res, await holidays.create(req, validated<CreateHolidayBody>(req, 'body')));
}
export async function updateHoliday(req: Request, res: Response) {
  ok(res, await holidays.update(req, idOf(req), validated<UpdateHolidayBody>(req, 'body')));
}
export async function deleteHoliday(req: Request, res: Response) {
  const id = idOf(req);
  await holidays.remove(req, id);
  ok(res, { id, deleted: true }); // same delete envelope as every other module
}

// announcements
export async function listAnnouncements(req: Request, res: Response) {
  await announcements.list(req, res, validated<AnnouncementListQuery>(req, 'query'));
}
export async function getAnnouncement(req: Request, res: Response) {
  ok(res, await announcements.get(req, idOf(req)));
}
export async function createAnnouncement(req: Request, res: Response) {
  created(res, await announcements.create(req, validated<CreateAnnouncementBody>(req, 'body')));
}
export async function updateAnnouncement(req: Request, res: Response) {
  ok(res, await announcements.update(req, idOf(req), validated<UpdateAnnouncementBody>(req, 'body')));
}
export async function deleteAnnouncement(req: Request, res: Response) {
  const id = idOf(req);
  await announcements.remove(req, id);
  ok(res, { id, deleted: true });
}
