// Audit log list query (BP §13.3 "filter by actor/action/entity/date", contract §5 lists).
import { exportFormat, listQueryShape, queryString, uuid } from '@wimb/shared';
import { z } from 'zod';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** 'YYYY-MM-DD' (school-local day) or an ISO-8601 instant. */
const dateOrInstant = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isNaN(Date.parse(v)), 'Must be a date (YYYY-MM-DD) or an ISO-8601 timestamp')
    .optional(),
);

export const AUDIT_ACTOR_TYPES = ['platform_user', 'user', 'parent_account', 'system'] as const;

export const auditListQuery = z.object({
  ...listQueryShape,
  format: exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv'),
  actorId: z.preprocess(emptyToUndefined, uuid().optional()),
  actorType: z.preprocess(emptyToUndefined, z.enum(AUDIT_ACTOR_TYPES).optional()),
  /** Exact action ('bus.create') or a prefix ending in '.' or '*' ('bus.', 'auth.*'). */
  action: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-z0-9_.]+\*?$/, 'Letters, digits, dots and underscores; optional trailing *')
      .optional(),
  ),
  entityType: queryString(60),
  entityId: z.preprocess(emptyToUndefined, uuid().optional()),
  from: dateOrInstant,
  to: dateOrInstant,
});
export type AuditListQuery = z.infer<typeof auditListQuery>;
