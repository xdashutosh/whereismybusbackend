// Error model and mapping (contract §5): AppError factories, envelopes, PostgreSQL/zod/multer/
// body-parser mapping, constraint registration, INTERNAL_ERROR hygiene.
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler, registerConstraintError, toAppError } from '../src/middleware/errorHandler.js';
import { notFound } from '../src/middleware/notFound.js';
import { requestId } from '../src/middleware/requestId.js';
import { accepted, created, envelope, list, noContent, ok } from '../src/shared/envelope.js';
import { AppError, assertFound, ERROR_CODES, ERROR_STATUS, fieldError, isAppError, rateLimited } from '../src/shared/errors.js';

const pg = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR', ...extra });

describe('AppError', () => {
  it('covers every contract code with its status', () => {
    for (const code of ERROR_CODES) expect(new AppError(code).status).toBe(ERROR_STATUS[code]);
    expect(ERROR_STATUS.ODOMETER_INVALID).toBe(422);
    expect(ERROR_STATUS.TRIP_ALREADY_ACTIVE).toBe(409);
    expect(() => new AppError('NOPE' as never)).toThrow(TypeError);
  });

  it('builds helpers', () => {
    const rl = rateLimited(1.2);
    expect(rl.headers).toEqual({ 'Retry-After': '2' });
    expect(fieldError('stops[0].id', 'Bad').details).toEqual([{ path: 'stops[0].id', message: 'Bad' }]);
    expect(() => assertFound(null)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(assertFound(0)).toBe(0);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(new AppError('CONFLICT', 'c', { details: { a: 1 } }).toJSON()).toEqual({ code: 'CONFLICT', message: 'c', details: { a: 1 } });
  });
});

describe('toAppError mapping', () => {
  it.each([
    [pg('23505', { constraint: 'buses_school_code_key' }), 'DUPLICATE'],
    [pg('23503', { detail: 'Key is still referenced from table "trips".' }), 'CONFLICT'],
    [pg('23503', { constraint: 'trips_bus_fk' }), 'VALIDATION_ERROR'],
    [pg('23P01'), 'CONFLICT'],
    [pg('22P02'), 'VALIDATION_ERROR'],
    [pg('23514', { constraint: 'buses_status_check' }), 'VALIDATION_ERROR'],
    [pg('42501'), 'FORBIDDEN'],
    [pg('25006'), 'FORBIDDEN'],
    [pg('P0001'), 'INVALID_STATE'],
    [pg('40001'), 'CONFLICT'],
    [pg('57014'), 'SERVICE_UNAVAILABLE'],
    [pg('57P01'), 'SERVICE_UNAVAILABLE'],
    [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'SERVICE_UNAVAILABLE'],
    [z.object({ a: z.string() }).safeParse({}).error, 'VALIDATION_ERROR'],
    [Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 }), 'PAYLOAD_TOO_LARGE'],
    [Object.assign(new Error('unsupported'), { status: 415 }), 'UNSUPPORTED_FILE'],
    [new Error('boom'), 'INTERNAL_ERROR'],
  ])('%s → %s', (err, code) => {
    expect(toAppError(err).code).toBe(code);
  });

  it('maps registered constraints (e.g. one active trip per bus)', () => {
    expect(toAppError(pg('23505', { constraint: 'one_active_trip_per_bus' })).code).toBe('TRIP_ALREADY_ACTIVE');
    registerConstraintError('odometer_not_decreasing', 'ODOMETER_INVALID', 'The odometer reading cannot decrease.');
    const e = toAppError(pg('23514', { constraint: 'odometer_not_decreasing' }));
    expect([e.code, e.status, e.message]).toEqual(['ODOMETER_INVALID', 422, 'The odometer reading cannot decrease.']);
  });
});

describe('errorHandler', () => {
  const build = (isProduction: boolean) => {
    const app = express();
    app.use(requestId());
    app.use(express.json());
    app.get('/boom', () => {
      throw new Error('select secret from internals');
    });
    app.get('/limited', () => {
      throw rateLimited(30);
    });
    app.get('/dup', () => {
      throw pg('23505', { constraint: 'users_admin_email_uq' });
    });
    app.get('/stream', (_req: Request, res: Response) => {
      res.write('partial');
      throw new Error('late failure');
    });
    app.use(notFound());
    app.use(errorHandler({ isProduction }));
    return app;
  };

  it('hides internals in production and adds debug details elsewhere', async () => {
    const prod = await request(build(true)).get('/boom');
    expect(prod.status).toBe(500);
    expect(prod.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId: prod.headers['x-request-id'] });
    const dev = await request(build(false)).get('/boom');
    expect(dev.body.error.details.debug).toBe('select secret from internals');
  });

  it('sets Retry-After and maps database errors', async () => {
    const app = build(true);
    const rl = await request(app).get('/limited');
    expect(rl.status).toBe(429);
    expect(rl.headers['retry-after']).toBe('30');
    const dup = await request(app).get('/dup');
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'DUPLICATE', details: { constraint: 'users_admin_email_uq' } });
  });

  it('ends an already-started stream instead of sending an envelope', async () => {
    const res = await request(build(true)).get('/stream');
    expect(res.text).toBe('partial');
  });
});

describe('envelope helpers', () => {
  it('builds success envelopes', async () => {
    const app = express();
    app.get('/ok', (_req, res) => ok(res, { a: 1 }));
    app.get('/null', (_req, res) => ok(res, undefined));
    app.get('/created', (_req, res) => created(res, { id: 'x' }, { location: '/x' }));
    app.get('/accepted', (_req, res) => accepted(res, { queued: true }));
    app.get('/list', (_req, res) => list(res, [1, 2], { page: 1, limit: 20, total: 2, totalPages: 1 }));
    app.get('/empty', (_req, res) => noContent(res));
    expect((await request(app).get('/ok')).body).toEqual({ success: true, data: { a: 1 } });
    expect((await request(app).get('/null')).body).toEqual({ success: true, data: null });
    const c = await request(app).get('/created');
    expect([c.status, c.headers.location]).toEqual([201, '/x']);
    expect((await request(app).get('/accepted')).status).toBe(202);
    expect((await request(app).get('/list')).body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect((await request(app).get('/empty')).status).toBe(204);
    expect(envelope([1], { page: 1, limit: 1, total: 1, totalPages: 1 })).toMatchObject({ success: true, meta: { total: 1 } });
  });
});
