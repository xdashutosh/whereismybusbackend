// HTTP layer of the notifications module: read req.valid, call the service, send the envelope.
import type { SchoolNotificationListQuery } from '@wimb/shared';
import type { Request, Response } from 'express';
import { validated } from '../../shared/validate.js';
import * as service from './service.js';

export async function list(req: Request, res: Response): Promise<void> {
  await service.listLog(req, res, validated<SchoolNotificationListQuery>(req, 'query'));
}
