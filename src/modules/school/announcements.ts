// Announcements (BP §20 #6, contract §9): CRUD /school/announcements for school → drivers /
// parents broadcasts with a publish window [publishedAt, expiresAt). Creating one emits
// 'announcement.published' after commit (the notifications module delivers push + inbox entries,
// immediately or at publishedAt when scheduled); edits and withdrawals emit 'announcement.changed'.
// New announcements require the 'announcements' feature to be in force for the school.
import type { AnnouncementDto, CreateAnnouncementBody, UpdateAnnouncementBody } from '@wimb/shared';
import type { Request, Response } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { assertFound, fieldError, forbidden } from '../../shared/errors.js';
import { events } from '../../shared/events.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import * as repo from './announcementRepository.js';
import type { AnnouncementEventPayload } from './events.js';
import type { AnnouncementListQuery } from './schemas.js';
import { loadSettings } from './settings.js';

const SORT = {
  allowed: { publishedAt: 'a.published_at', expiresAt: 'a.expires_at', title: 'a.title', createdAt: 'a.created_at', isPinned: 'a.is_pinned' },
  defaultSort: '-publishedAt',
  tiebreaker: 'a.id',
};

export function toDto(r: repo.AnnouncementRow): AnnouncementDto {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    audience: r.audience,
    isPinned: r.is_pinned,
    publishedAt: r.published_at,
    expiresAt: r.expires_at,
    state: r.state,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CSV_COLUMNS: CsvColumn<AnnouncementDto>[] = [
  { header: 'Title', key: 'title' },
  { header: 'Audience', key: 'audience' },
  { header: 'State', key: 'state' },
  { header: 'Pinned', value: (r) => (r.isPinned ? 'yes' : 'no') },
  { header: 'Published at (UTC)', key: 'publishedAt' },
  { header: 'Expires at (UTC)', key: 'expiresAt' },
  { header: 'Created by', key: 'createdByName' },
  { header: 'Body', key: 'body' },
];

function filterOf(q: AnnouncementListQuery): repo.AnnouncementFilter {
  return { audience: q.audience, states: q.state, pinned: q.pinned, q: q.q };
}

/** GET /school/announcements (JSON page or CSV). */
export async function list(req: Request, res: Response, q: AnnouncementListQuery): Promise<void> {
  const filter = filterOf(q);
  const { orderBy } = parseSort(q.sort, SORT);
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<AnnouncementDto>(res, { fileName: 'announcements.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toDto));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  sendList(res, rows.map((r) => toDto(r as repo.AnnouncementRow)), listMeta({ page, limit, total }));
}

/** GET /school/announcements/:id */
export function get(req: Request, id: string): Promise<AnnouncementDto> {
  return withRequestTenant(req, async (tx) => toDto(assertFound(await repo.find(tx, id), 'The announcement was not found.')), { readOnly: true });
}

function eventPayload(schoolId: string, d: AnnouncementDto): AnnouncementEventPayload {
  return {
    schoolId,
    announcementId: d.id,
    audience: d.audience,
    title: d.title,
    isPinned: d.isPinned,
    publishedAt: d.publishedAt,
    expiresAt: d.expiresAt,
    scheduled: Date.parse(d.publishedAt) > Date.now(),
  };
}

const auditView = (d: AnnouncementDto) => ({ title: d.title, body: d.body, audience: d.audience, isPinned: d.isPinned, publishedAt: d.publishedAt, expiresAt: d.expiresAt });

/** POST /school/announcements */
export async function create(req: Request, body: CreateAnnouncementBody): Promise<AnnouncementDto> {
  const schoolId = req.tenant!.schoolId;
  if (body.expiresAt && Date.parse(body.expiresAt) <= Date.now()) throw fieldError('expiresAt', 'Must be in the future');
  const dto = await withRequestTenant(req, async (tx) => {
    const { dto: settings } = await loadSettings(tx);
    if (!settings.effective.features.announcements) throw forbidden('Announcements are not enabled for this school.', { reason: 'FEATURE_DISABLED', feature: 'announcements' });
    const id = await repo.insert(tx, {
      title: body.title,
      body: body.body,
      audience: body.audience,
      isPinned: body.isPinned,
      publishedAt: body.publishedAt ?? null,
      expiresAt: body.expiresAt ?? null,
    });
    const created = toDto(assertFound(await repo.find(tx, id)));
    if (created.expiresAt && Date.parse(created.expiresAt) <= Date.parse(created.publishedAt)) throw fieldError('expiresAt', 'Must be after the publish time');
    await audit.log(tx, { action: 'announcement.create', entityType: 'announcement', entityId: id, new: auditView(created) });
    return created;
  });
  events.emit('announcement.published', eventPayload(schoolId, dto));
  return dto;
}

/** PATCH /school/announcements/:id */
export async function update(req: Request, id: string, body: UpdateAnnouncementBody): Promise<AnnouncementDto> {
  const schoolId = req.tenant!.schoolId;
  const result = await withRequestTenant(req, async (tx) => {
    const before = toDto(assertFound(await repo.find(tx, id, { lock: true }), 'The announcement was not found.'));
    const next: repo.AnnouncementValues = {
      title: body.title ?? before.title,
      body: body.body ?? before.body,
      audience: body.audience ?? before.audience,
      isPinned: body.isPinned ?? before.isPinned,
      publishedAt: body.publishedAt ?? before.publishedAt,
      expiresAt: body.expiresAt !== undefined ? body.expiresAt : before.expiresAt,
    };
    if (next.expiresAt && Date.parse(next.expiresAt) <= Date.parse(next.publishedAt!)) throw fieldError('expiresAt', 'Must be after the publish time');
    await repo.update(tx, id, next);
    const after = toDto(assertFound(await repo.find(tx, id)));
    const diff = changedFields(auditView(before), auditView(after));
    const changed = Object.keys(diff.new);
    if (changed.length) await audit.log(tx, { action: 'announcement.update', entityType: 'announcement', entityId: id, ...diff });
    return { dto: after, changed };
  });
  if (result.changed.length) events.emit('announcement.changed', { ...eventPayload(schoolId, result.dto), change: 'updated', changedFields: result.changed });
  return result.dto;
}

/** DELETE /school/announcements/:id (soft delete = withdrawn). */
export async function remove(req: Request, id: string): Promise<void> {
  const schoolId = req.tenant!.schoolId;
  const before = await withRequestTenant(req, async (tx) => {
    const row = toDto(assertFound(await repo.find(tx, id, { lock: true }), 'The announcement was not found.'));
    await repo.softDelete(tx, id);
    await audit.log(tx, { action: 'announcement.delete', entityType: 'announcement', entityId: id, old: auditView(row) });
    return row;
  });
  events.emit('announcement.changed', { ...eventPayload(schoolId, before), change: 'deleted', changedFields: [] });
}
