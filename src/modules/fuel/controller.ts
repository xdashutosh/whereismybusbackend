// HTTP layer of the fuel module: read req.valid, call the service, send the envelope.
import type { Request, Response } from 'express';
import { created, ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import * as mileage from './mileage.js';
import type * as s from './schemas.js';
import * as service from './service.js';

const id = (req: Request) => validated<s.FuelLogParams>(req, 'params').id;

export const list = (req: Request, res: Response) => service.list(req, res, validated<s.FuelLogListQuery>(req, 'query'));
export async function get(req: Request, res: Response) {
  ok(res, await service.get(req, id(req)));
}
export async function create(req: Request, res: Response) {
  created(res, await service.create(req, validated<s.CreateFuelLogBody>(req, 'body')));
}
export async function update(req: Request, res: Response) {
  ok(res, await service.update(req, id(req), validated<s.UpdateFuelLogBody>(req, 'body')));
}
export async function remove(req: Request, res: Response) {
  ok(res, await service.remove(req, id(req)));
}
export async function mileageTrend(req: Request, res: Response) {
  ok(res, await mileage.trend(req, validated<s.MileageTrendQuery>(req, 'query')));
}
export const mileageSummary = (req: Request, res: Response) => mileage.summary(req, res, validated<s.MileageSummaryQuery>(req, 'query'));
