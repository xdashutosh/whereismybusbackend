// HTTP layer of the platform module: read req.valid, call the service, send an envelope.
// Responses that may carry a temporary password are never cached (Cache-Control: no-store).
import type { Request, Response } from 'express';
import { created, ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import { getHealth, listUsage } from './health.js';
import { activateSchool, deactivateSchool, deleteSchool, resetAdminPassword } from './lifecycle.js';
import { removeLogo, uploadLogo } from './logo.js';
import { createSchool, getSchool, listSchools, updateSchool } from './schools.js';
import type { ActivateSchoolBody, CreateSchool, DeactivateSchoolBody, PlatformSettingsBody, ResetAdminPasswordBody, SchoolListQuery, SubscriptionBody, UpdateSchool, UsageListQuery } from './schemas.js';
import { getSettings, putSettings } from './settings.js';
import { getSubscription, putSubscription } from './subscriptions.js';

const idOf = (req: Request) => validated<{ id: string }>(req, 'params').id;
const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

export const list = (req: Request, res: Response) => listSchools(req, res, validated<SchoolListQuery>(req, 'query'));

export async function create(req: Request, res: Response) {
  const result = await createSchool(req, validated<CreateSchool>(req, 'body'));
  noStore(res);
  created(res, result, { location: `${req.baseUrl}/platform/schools/${result.school.id}` });
}

export async function detail(req: Request, res: Response) {
  ok(res, await getSchool(req, idOf(req)));
}

export async function update(req: Request, res: Response) {
  ok(res, await updateSchool(req, idOf(req), validated<UpdateSchool>(req, 'body')));
}

export async function remove(req: Request, res: Response) {
  ok(res, await deleteSchool(req, idOf(req), validated<{ reason?: string | null }>(req, 'body')));
}

export async function activate(req: Request, res: Response) {
  ok(res, await activateSchool(req, idOf(req), validated<ActivateSchoolBody>(req, 'body')));
}

export async function deactivate(req: Request, res: Response) {
  ok(res, await deactivateSchool(req, idOf(req), validated<DeactivateSchoolBody>(req, 'body')));
}

export async function resetPassword(req: Request, res: Response) {
  const result = await resetAdminPassword(req, idOf(req), validated<ResetAdminPasswordBody>(req, 'body'));
  noStore(res);
  ok(res, result);
}

export async function logoUpload(req: Request, res: Response) {
  ok(res, await uploadLogo(req, idOf(req)));
}

export async function logoRemove(req: Request, res: Response) {
  ok(res, await removeLogo(req, idOf(req)));
}

export async function subscription(req: Request, res: Response) {
  ok(res, await getSubscription(req, idOf(req)));
}

export async function subscriptionPut(req: Request, res: Response) {
  ok(res, await putSubscription(req, idOf(req), validated<SubscriptionBody>(req, 'body')));
}

export async function settings(req: Request, res: Response) {
  ok(res, await getSettings(req));
}

export async function settingsPut(req: Request, res: Response) {
  ok(res, await putSettings(req, validated<PlatformSettingsBody>(req, 'body')));
}

export async function health(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await getHealth(req));
}

export const usage = (req: Request, res: Response) => listUsage(req, res, validated<UsageListQuery>(req, 'query'));
