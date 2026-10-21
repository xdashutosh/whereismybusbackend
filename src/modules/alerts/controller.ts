// HTTP layer of the alerts module: read req.valid, call the inbox service, send the envelope.
import type { Request, Response } from 'express';
import { list as sendList, ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import * as inbox from './inbox.js';
import type * as s from './schemas.js';

const id = (req: Request) => validated<s.AlertParams>(req, 'params').id;

export async function list(req: Request, res: Response) {
  const q = validated<s.AlertListQuery>(req, 'query');
  if (q.format === 'csv') {
    await inbox.exportCsv(req, res, q);
    return;
  }
  const { items, meta } = await inbox.list(req, q);
  sendList(res, items, meta);
}

export async function get(req: Request, res: Response) {
  ok(res, await inbox.detail(req, id(req)));
}

export async function act(req: Request, res: Response) {
  ok(res, await inbox.act(req, id(req), validated<s.AlertActionBody>(req, 'body')));
}
