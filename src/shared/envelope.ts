// Success envelopes (contract §5). Controllers never build envelopes by hand:
//   { success: true, data }                single object / array
//   { success: true, data: [...], meta }   paginated list (meta from pagination.listMeta)
import type { ListMeta } from '@wimb/shared';
import type { Response } from 'express';

export function ok<T>(res: Response, data: T, { status = 200, headers }: { status?: number; headers?: Record<string, string> } = {}): Response {
  if (headers) res.set(headers);
  return res.status(status).json({ success: true, data: data ?? null });
}

export function created<T>(res: Response, data: T, { location, headers }: { location?: string; headers?: Record<string, string> } = {}): Response {
  if (location) res.location(location);
  return ok(res, data, { status: 201, headers });
}

export function accepted<T>(res: Response, data: T): Response {
  return ok(res, data, { status: 202 });
}

export function list<T>(res: Response, items: T[], meta: ListMeta, { headers }: { headers?: Record<string, string> } = {}): Response {
  if (headers) res.set(headers);
  return res.status(200).json({ success: true, data: items, meta });
}

export function noContent(res: Response): Response {
  return res.status(204).end();
}

/** Builds (without sending) a success envelope (idempotency replay, socket snapshots). */
export function envelope<T>(data: T, meta?: ListMeta) {
  return meta ? { success: true as const, data, meta } : { success: true as const, data: data ?? null };
}

export const respond = { ok, created, accepted, list, noContent, envelope };
export default respond;
