// Request validation with zod v3 (contract §2/§5). validate({ params, query, body }) parses each
// part and stores the results in req.valid.{params,query,body}. Express 5 exposes req.query via a
// getter, so parsed values are NEVER written back onto req.query/req.body. Unknown keys are
// stripped (z.object default) — mass assignment of school_id is impossible.
// Failures become VALIDATION_ERROR with details [{ path: 'stops[2].stopId', message }].
import type { FieldIssue } from '@wimb/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodError, type ZodTypeAny } from 'zod';
import { validationError } from './errors.js';

/** ['stops', 2, 'stopId'] → 'stops[2].stopId'. */
export function formatPath(segments: readonly (string | number)[]): string {
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${seg}` : String(seg);
  }
  return out;
}

/** zod issues → [{ path, message }] (unions flattened to their most relevant branch). */
export function zodIssuesToDetails(error: ZodError, prefix: (string | number)[] = []): FieldIssue[] {
  const details: FieldIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'invalid_union' && issue.unionErrors.length) {
      const best = issue.unionErrors.find((e) => e.issues.some((i) => i.code !== 'invalid_type')) ?? issue.unionErrors[0]!;
      details.push(...zodIssuesToDetails(best, prefix));
      continue;
    }
    details.push({ path: formatPath([...prefix, ...issue.path]) || formatPath(prefix) || '(root)', message: issue.message });
  }
  return details;
}

/** Duck-typed zod schema check (schemas may come from @wimb/shared's own zod copy). */
export function isZodSchema(value: unknown): value is ZodTypeAny {
  return Boolean(value && typeof value === 'object' && typeof (value as { safeParse?: unknown }).safeParse === 'function');
}

type Part = 'params' | 'query' | 'body';
const PARTS: readonly Part[] = ['params', 'query', 'body'];

export interface ValidateSchemas {
  params?: ZodTypeAny | z.ZodRawShape;
  query?: ZodTypeAny | z.ZodRawShape;
  body?: ZodTypeAny | z.ZodRawShape;
}

/** Parsed request parts (typed access: `req.valid.body as z.infer<typeof schema>` or validated()). */
export interface ValidData {
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

declare module 'express-serve-static-core' {
  interface Request {
    valid?: ValidData;
  }
}

/** Middleware factory. Plain shapes are wrapped with z.object(). */
export function validate(schemas: ValidateSchemas): RequestHandler {
  const compiled: Partial<Record<Part, ZodTypeAny>> = {};
  for (const part of PARTS) {
    const s = schemas[part];
    if (!s) continue;
    compiled[part] = isZodSchema(s) ? s : z.object(s);
  }
  return function validateRequest(req: Request, _res: Response, next: NextFunction) {
    const valid: ValidData = req.valid ?? {};
    const details: FieldIssue[] = [];
    for (const part of PARTS) {
      const schema = compiled[part];
      if (!schema) continue;
      const input: unknown = part === 'body' ? (req.body ?? {}) : (req[part] ?? {});
      const result = schema.safeParse(input);
      if (result.success) valid[part] = result.data;
      else details.push(...zodIssuesToDetails(result.error, part === 'body' ? [] : [part]));
    }
    if (details.length) {
      next(validationError('The request is invalid.', details));
      return;
    }
    req.valid = valid;
    next();
  };
}

/** Typed accessor: const body = validated<Body>(req, 'body'). Throws if validate() did not run. */
export function validated<T>(req: Request, part: Part): T {
  if (!req.valid || !(part in req.valid)) throw new Error(`validate() did not run for ${part}`);
  return req.valid[part] as T;
}

/** Parses a value with a schema or throws VALIDATION_ERROR (service-level checks). */
export function parseOrThrow<S extends ZodTypeAny>(schema: S, value: unknown, prefix: (string | number)[] = []): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError('The request is invalid.', zodIssuesToDetails(result.error, prefix));
  return result.data as z.output<S>;
}

export { z };
