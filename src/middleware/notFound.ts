// Unknown route → 404 NOT_FOUND envelope.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { notFound as notFoundError } from '../shared/errors.js';

export function notFound(): RequestHandler {
  return function notFoundMiddleware(req: Request, _res: Response, next: NextFunction) {
    next(notFoundError(`Route ${req.method} ${String(req.originalUrl).split('?')[0]} not found.`));
  };
}
