// HTTP layer of the tracking module: read req.valid, call the service, send the envelope.
import type { LocationIngestBody } from '@wimb/shared';
import type { Request, Response } from 'express';
import { ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import { ingestLocations } from './ingest.js';
import type { PathQuery } from './schemas.js';
import * as service from './service.js';

const idOf = (req: Request) => validated<{ id: string }>(req, 'params').id;

export async function ingest(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  ok(res, await ingestLocations(req, idOf(req), validated<LocationIngestBody>(req, 'body')));
}

export async function fleetLive(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  ok(res, await service.fleetLive(req));
}

export async function tripPath(req: Request, res: Response) {
  ok(res, await service.tripPath(req, idOf(req), validated<PathQuery>(req, 'query')));
}

export async function driverTripRoute(req: Request, res: Response) {
  ok(res, await service.driverTripRoute(req, idOf(req)));
}
