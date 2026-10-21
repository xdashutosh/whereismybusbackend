// Central error handling (contract §5). Every failure leaves as
//   { success:false, error:{ code, message, details?, requestId } } with the mapped HTTP status.
// Maps AppError · ZodError · malformed/oversized JSON · multer · PostgreSQL errors:
//   23505 DUPLICATE (or a registered constraint mapping, e.g. one_active_trip_per_bus →
//   TRIP_ALREADY_ACTIVE) · 23503 CONFLICT/VALIDATION_ERROR · 23P01 CONFLICT · 22xxx/23502/23514
//   VALIDATION_ERROR (22023 = invalid_parameter_value raised by core functions) · 42501 (RLS WITH
//   CHECK) FORBIDDEN · 25006 FORBIDDEN · P0001 INVALID_STATE · P0002 (no_data_found raised by core
//   functions, e.g. unknown school) NOT_FOUND · 40001/40P01 CONFLICT · 57014 SERVICE_UNAVAILABLE ·
//   connection loss SERVICE_UNAVAILABLE · a row outside every partition ("no partition of relation",
//   23514 — e.g. location_points beyond the pre-created months) SERVICE_UNAVAILABLE (retryable: the
//   partition-maintenance job creates it; clients must keep the data and retry).
// Unknown errors → 500 INTERNAL_ERROR with a generic message (outside production details.debug
// carries the original message). 5xx are logged with the request id; unexpected ones (an
// INTERNAL_ERROR, or any non-AppError mapped to 5xx such as a lost DB connection) are also reported
// to Sentry when it is enabled (shared/sentry.ts scrubs secrets and personal data).
import type { ErrorCode } from '@wimb/shared';
import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import config from '../config/index.js';
import { isPgError, isTransientConnectionError, type PgErrorLike } from '../db/pool.js';
import { AppError, isAppError } from '../shared/errors.js';
import { logger as rootLogger, type Logger } from '../shared/logger.js';
import { captureError, type ErrorContext } from '../shared/sentry.js';
import { routeLabel } from '../shared/httpMetrics.js';
import { zodIssuesToDetails } from '../shared/validate.js';

const constraintErrors = new Map<string, { code: ErrorCode; message?: string }>([
  ['one_active_trip_per_bus', { code: 'TRIP_ALREADY_ACTIVE', message: 'This bus already has a trip in progress.' }],
]);

/** Maps a named constraint violation to an error code (module-specific friendly errors). */
export function registerConstraintError(constraint: string, code: ErrorCode, message?: string): void {
  constraintErrors.set(constraint, { code, message });
}

function fromPg(err: PgErrorLike): AppError | null {
  const constraint = err.constraint;
  const mapped = constraint ? constraintErrors.get(constraint) : undefined;
  if (err.code === '23514' && !constraint && /no partition of relation/i.test(err.message ?? '')) {
    return new AppError('SERVICE_UNAVAILABLE', 'The data cannot be stored right now. Please retry later.', { details: { reason: 'NO_PARTITION' } });
  }
  if (mapped && ['23505', '23P01', '23514', '23503'].includes(err.code ?? '')) return new AppError(mapped.code, mapped.message, { details: { constraint } });
  switch (err.code) {
    case '23505':
      return new AppError('DUPLICATE', undefined, { details: { constraint } });
    case '23P01':
      return new AppError('CONFLICT', undefined, { details: { constraint } });
    case '23503':
      if (/still referenced|update or delete on table/i.test(`${err.message ?? ''} ${err.detail ?? ''}`)) {
        return new AppError('CONFLICT', 'The record is referenced by other records.', { details: { constraint } });
      }
      return new AppError('VALIDATION_ERROR', 'A referenced record does not exist.', { details: [{ path: constraint ?? '(reference)', message: 'Referenced record does not exist' }] });
    case '22P02':
    case '22007':
    case '22008':
    case '22001':
    case '22003':
    case '22023':
    case '23502':
    case '23514':
      return new AppError('VALIDATION_ERROR', undefined, { details: [{ path: constraint ?? err.column ?? '(value)', message: 'Invalid value' }] });
    case '42501':
    case '25006':
      return new AppError('FORBIDDEN');
    case 'P0001':
      return new AppError('INVALID_STATE');
    case 'P0002':
      return new AppError('NOT_FOUND');
    case '40001':
    case '40P01':
      return new AppError('CONFLICT', 'The operation conflicted with a concurrent change. Please retry.');
    case '57014':
      return new AppError('SERVICE_UNAVAILABLE', 'The operation took too long. Please retry.');
    default:
      return null;
  }
}

function fromMulter(err: multer.MulterError): AppError {
  if (err.code === 'LIMIT_FILE_SIZE') return new AppError('PAYLOAD_TOO_LARGE', 'The uploaded file is too large.', { details: { field: err.field } });
  const messages: Record<string, string> = {
    LIMIT_FILE_COUNT: 'Only one file may be uploaded.',
    LIMIT_UNEXPECTED_FILE: `Unexpected file field "${err.field ?? ''}".`,
    LIMIT_PART_COUNT: 'Too many form parts.',
    LIMIT_FIELD_KEY: 'A form field name is too long.',
    LIMIT_FIELD_VALUE: 'A form field value is too long.',
    LIMIT_FIELD_COUNT: 'Too many form fields.',
  };
  const message = messages[err.code] ?? 'Invalid multipart upload.';
  return new AppError('VALIDATION_ERROR', message, { details: [{ path: err.field ?? 'file', message }] });
}

/** Converts any thrown value into an AppError (also used by socket/stream handlers). */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  if (err instanceof ZodError) return new AppError('VALIDATION_ERROR', undefined, { details: zodIssuesToDetails(err) });
  if (err instanceof multer.MulterError) return fromMulter(err);
  if (err && typeof err === 'object') {
    const e = err as { type?: string; message?: string; status?: number; statusCode?: number; expose?: boolean; severity?: string };
    if (e.type === 'entity.parse.failed') return new AppError('VALIDATION_ERROR', 'Malformed JSON in request body.', { details: [{ path: '(body)', message: 'Malformed JSON' }] });
    if (e.type === 'entity.too.large') return new AppError('PAYLOAD_TOO_LARGE');
    if (e.type === 'encoding.unsupported' || e.type === 'charset.unsupported') return new AppError('VALIDATION_ERROR', 'Unsupported request encoding.');
    if (e.type === 'request.aborted') return new AppError('VALIDATION_ERROR', 'The request was aborted.');
    if (typeof e.message === 'string' && /^(Multipart|Unexpected end of form|Malformed part header)/i.test(e.message)) {
      return new AppError('VALIDATION_ERROR', 'Malformed multipart body.', { details: [{ path: '(body)', message: 'Malformed multipart body' }] });
    }
    if (isPgError(err) && e.severity) {
      const mapped = fromPg(err);
      if (mapped) return mapped;
    }
    if (isTransientConnectionError(err)) return new AppError('SERVICE_UNAVAILABLE', 'The database is temporarily unavailable. Please retry.');
    const status = e.status ?? e.statusCode;
    if (Number.isInteger(status) && status! >= 400 && status! < 500) {
      if (status === 413) return new AppError('PAYLOAD_TOO_LARGE');
      if (status === 415) return new AppError('UNSUPPORTED_FILE', 'Unsupported content type.');
      return new AppError('VALIDATION_ERROR', e.expose ? e.message : undefined);
    }
  }
  return new AppError('INTERNAL_ERROR', undefined, { cause: err });
}

/** Whether a failure is unexpected (reported to Sentry): an internal error or a non-AppError mapped to 5xx. */
export function isUnexpectedFailure(err: unknown, appErr: AppError): boolean {
  return appErr.code === 'INTERNAL_ERROR' || (appErr.status >= 500 && !isAppError(err));
}

export interface ErrorHandlerOptions {
  logger?: Logger;
  isProduction?: boolean;
  /** Error reporter for unexpected failures (default: Sentry, a no-op when disabled). */
  report?: (err: unknown, ctx: ErrorContext) => unknown;
}

export function errorHandler({ logger = rootLogger, isProduction = config.isProduction, report = captureError }: ErrorHandlerOptions = {}): ErrorRequestHandler {
  return function errorHandlerMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
    const appErr = toAppError(err);
    const log = req.log ?? logger;
    if (appErr.status >= 500) log.error({ err, requestId: req.id, code: appErr.code }, 'Request failed');
    else log.debug({ code: appErr.code, requestId: req.id }, 'Request rejected');
    if (isUnexpectedFailure(err, appErr)) {
      report(err, {
        source: 'http',
        requestId: req.id,
        method: req.method,
        route: routeLabel(req),
        status: appErr.status,
        code: appErr.code,
        schoolId: req.tenant?.schoolId ?? req.auth?.schoolId ?? null,
        actorId: req.auth?.actorId ?? null,
        actorRole: req.auth?.role ?? null,
      });
    }
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (appErr.headers) res.set(appErr.headers);
    const body: { code: ErrorCode; message: string; details?: unknown; requestId: string } = { code: appErr.code, message: appErr.message, requestId: req.id };
    if (appErr.code === 'INTERNAL_ERROR') {
      body.message = 'An unexpected error occurred.';
      if (!isProduction && err !== appErr) body.details = { debug: err instanceof Error ? err.message : String(err) };
    } else if (appErr.details !== undefined) {
      body.details = appErr.details;
    }
    res.status(appErr.status).json({ success: false, error: { code: body.code, message: body.message, ...(body.details !== undefined ? { details: body.details } : {}), requestId: body.requestId } });
  };
}
