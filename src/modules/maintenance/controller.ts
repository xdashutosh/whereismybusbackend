// HTTP layer of the maintenance module: read req.valid, call the service, send the envelope.
import type { Request, Response } from 'express';
import { created, ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import type * as s from './schemas.js';
import * as service from './service.js';

const id = (req: Request) => validated<s.MaintenanceLogParams>(req, 'params').id;

export const list = (req: Request, res: Response) => service.list(req, res, validated<s.MaintenanceLogListQuery>(req, 'query'));
export const due = (req: Request, res: Response) => service.due(req, res, validated<s.MaintenanceDueQuery>(req, 'query'));
export async function get(req: Request, res: Response) {
  ok(res, await service.get(req, id(req)));
}
export async function create(req: Request, res: Response) {
  created(res, await service.create(req, validated<s.CreateMaintenanceLogBody>(req, 'body')));
}
export async function update(req: Request, res: Response) {
  ok(res, await service.update(req, id(req), validated<s.UpdateMaintenanceLogBody>(req, 'body')));
}
export async function remove(req: Request, res: Response) {
  ok(res, await service.remove(req, id(req)));
}
