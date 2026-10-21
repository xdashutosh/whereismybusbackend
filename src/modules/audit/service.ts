// Audit log listing (BP §8.2 /platform/audit-logs, §8.3 /school/audit-logs, §13.3): filters by
// actor, action (exact or prefix), entity and date range; whitelisted sort; JSON pages or CSV.
// Date-only bounds are school-local days (platform: the default timezone); `to` is inclusive.
import type { Request, Response } from 'express';
import { DateTime } from 'luxon';
import config from '../../config/index.js';
import { withPlatform, type Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { fieldError } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import * as repo from './repository.js';
import type { AuditListQuery } from './schemas.js';

const SORT = { allowed: { createdAt: 'a.created_at', action: 'a.action', actorName: 'a.actor_name', entityType: 'a.entity_type' }, defaultSort: '-createdAt', tiebreaker: 'a.id' };

export function toDto(r: repo.AuditRow) {
  return {
    id: r.id,
    createdAt: r.created_at,
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorName: r.actor_name,
    ip: r.ip,
    userAgent: r.user_agent,
    requestId: r.request_id,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    oldValues: r.old_values ?? null,
    newValues: r.new_values ?? null,
  };
}
export type AuditLogDto = ReturnType<typeof toDto>;

const CSV_COLUMNS: CsvColumn<AuditLogDto>[] = [
  { header: 'Time (UTC)', key: 'createdAt' },
  { header: 'Actor type', key: 'actorType' },
  { header: 'Actor', key: 'actorName' },
  { header: 'Actor ID', key: 'actorId' },
  { header: 'Action', key: 'action' },
  { header: 'Entity type', key: 'entityType' },
  { header: 'Entity ID', key: 'entityId' },
  { header: 'IP', key: 'ip' },
  { header: 'Request ID', key: 'requestId' },
  { header: 'Old values', value: (r) => (r.oldValues === null ? '' : JSON.stringify(r.oldValues)) },
  { header: 'New values', value: (r) => (r.newValues === null ? '' : JSON.stringify(r.newValues)) },
];

/** 'YYYY-MM-DD' → start of that local day (or of the next day for an inclusive `to`). */
function bound(value: string | undefined, tz: string, field: 'from' | 'to'): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = DateTime.fromISO(value, { zone: tz });
    if (!day.isValid) throw fieldError(field, 'Must be a valid calendar date');
    return (field === 'to' ? day.plus({ days: 1 }) : day).startOf('day').toUTC().toISO() ?? undefined;
  }
  return new Date(value).toISOString();
}

function filterOf(scope: repo.AuditFilter['scope'], q: AuditListQuery, tz: string): repo.AuditFilter {
  const fromIso = bound(q.from, tz, 'from');
  const toIso = bound(q.to, tz, 'to');
  if (fromIso && toIso && fromIso >= toIso) throw fieldError('to', 'Must be after "from"');
  return { scope, actorId: q.actorId, actorType: q.actorType, action: q.action, entityType: q.entityType, entityId: q.entityId, fromIso, toIso, q: q.q };
}

async function respond(res: Response, q: AuditListQuery, run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, filter: repo.AuditFilter, fileName: string) {
  const { orderBy } = parseSort(q.sort, SORT);
  if (q.format === 'csv') {
    const rows = await run((tx) => repo.exportRows(tx, filter, orderBy));
    const csv = createCsvWriter<AuditLogDto>(res, { fileName, columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toDto));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await run((tx) => repo.page(tx, filter, { orderBy, limit, offset }));
  sendList(res, rows.map((r) => toDto(r as repo.AuditRow)), listMeta({ page, limit, total }));
}

/** GET /school/audit-logs — the current school's trail (school admins). */
export function listSchool(req: Request, res: Response, q: AuditListQuery) {
  const tz = req.tenant?.timezone ?? config.defaultTimezone;
  return respond(res, q, (fn) => withRequestTenant(req, fn, { readOnly: true }), filterOf('school', q, tz), 'audit-log.csv');
}

/** GET /platform/audit-logs — platform-level actions only (super admins). */
export function listPlatform(req: Request, res: Response, q: AuditListQuery) {
  return respond(res, q, (fn) => withPlatform({ actorId: req.auth!.actorId }, fn, { readOnly: true }), filterOf('platform', q, config.defaultTimezone), 'platform-audit-log.csv');
}
