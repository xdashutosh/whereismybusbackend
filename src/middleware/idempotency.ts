// Idempotency-Key handling (contract §5, BP §7.2). Mount AFTER authenticate() (and resolveTenant
// for school routes) on creates and uploads:
// - no header → runs normally (unless { required: true } → VALIDATION_ERROR)
// - key: 8–128 chars of [A-Za-z0-9._:~-]
// - same key + same method/path/body → stored response replayed with `Idempotent-Replayed: true`
// - same key + different request → 409 CONFLICT (details.reason = IDEMPOTENCY_KEY_REUSED)
// - same key while the first request is still running → 409 CONFLICT (IDEMPOTENCY_IN_PROGRESS)
// - final status < 500 is stored for 24 h; 5xx and non-JSON responses release the key
// - a client disconnect does NOT release the claim: the handler keeps running and its response is
//   still stored, so a retry after a dropped connection is answered 409 IN_PROGRESS, then replayed
// Keys are scoped by principal and school, so they never collide across users or tenants.
import { HEADERS } from '@wimb/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { conflict, unauthenticated, validationError } from '../shared/errors.js';
import { IDEMPOTENCY_KEY_RE, idempotencyStore as defaultStore, requestHash, type IdempotencyStore } from '../shared/idempotency.js';
import { logger as rootLogger } from '../shared/logger.js';

const log = rootLogger.child({ module: 'idempotency' });

export function idempotency({ required = false, store = defaultStore }: { required?: boolean; store?: IdempotencyStore } = {}): RequestHandler {
  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
    const key = req.get(HEADERS.IDEMPOTENCY_KEY);
    const path = `headers.${HEADERS.IDEMPOTENCY_KEY.toLowerCase()}`;
    if (key === undefined || key === '') {
      if (required) throw validationError(`The ${HEADERS.IDEMPOTENCY_KEY} header is required.`, [{ path, message: 'Required' }]);
      return next();
    }
    if (!IDEMPOTENCY_KEY_RE.test(key)) throw validationError(`Invalid ${HEADERS.IDEMPOTENCY_KEY} header.`, [{ path, message: 'Must be 8–128 characters: letters, digits, . _ : ~ -' }]);
    if (!req.auth) throw unauthenticated();

    const scope = `${req.auth.ownerType}:${req.auth.actorId}:${req.tenant?.schoolId ?? req.auth.schoolId ?? '-'}`;
    const method = req.method.toUpperCase();
    const urlPath = String(req.originalUrl).split('?')[0]!;
    const hash = requestHash({ method, path: urlPath, body: req.body ?? null });
    const claim = await store.begin(scope, key, hash);
    if (claim.state === 'mismatch') throw conflict('This Idempotency-Key was already used with a different request.', { reason: 'IDEMPOTENCY_KEY_REUSED' });
    if (claim.state === 'in_progress') throw conflict('A request with this Idempotency-Key is still being processed.', { reason: 'IDEMPOTENCY_IN_PROGRESS' });
    if (claim.state === 'replay') {
      res.setHeader('Idempotent-Replayed', 'true');
      if (claim.body === null || claim.body === undefined) return res.status(claim.statusCode).end();
      return res.status(claim.statusCode).json(claim.body);
    }

    // `settled` tracks whether the handler PRODUCED a response, never whether the socket is still
    // open: a client that disconnects mid-request (mobile network drop) keeps the in-flight claim, so
    // its retry gets IDEMPOTENCY_IN_PROGRESS and then the stored replay — the create never runs twice.
    // A handler that never responds is covered by STALE_IN_FLIGHT_SECONDS.
    let settled = false;
    const originalJson = res.json.bind(res);
    const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response;
    res.json = (body: unknown) => {
      if (settled) return originalJson(body);
      settled = true;
      const status = res.statusCode;
      const persist = status >= 500 ? store.release(scope, key) : store.complete(scope, key, hash, status, body);
      persist
        .catch((err: unknown) => log.error({ err, requestId: req.id }, 'Failed to persist idempotency result'))
        .finally(() => originalJson(body));
      return res;
    };
    // Non-JSON responses (res.end/res.send without json, streams) cannot be replayed: release the key.
    res.end = ((...args: unknown[]) => {
      if (!settled) {
        settled = true;
        store.release(scope, key).catch((err: unknown) => log.error({ err, requestId: req.id }, 'Failed to release idempotency key'));
      }
      return originalEnd(...args);
    }) as Response['end'];
    return next();
  };
}
