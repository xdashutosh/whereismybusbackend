// Request id (contract §5): accepts a well-formed incoming X-Request-Id or generates a UUID;
// exposed as req.id, echoed in X-Request-Id and in every error envelope. The rest of the request
// runs inside a request context (shared/requestContext.ts) carrying id, ip and user agent.
import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { runWithRequestContext } from '../shared/requestContext.js';

const VALID_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestId(): RequestHandler {
  return function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
    const incoming = req.get('x-request-id');
    const id = incoming && VALID_ID.test(incoming) ? incoming : crypto.randomUUID();
    req.id = id;
    res.setHeader('X-Request-Id', id);
    runWithRequestContext({ requestId: id, ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null }, () => next());
  };
}
