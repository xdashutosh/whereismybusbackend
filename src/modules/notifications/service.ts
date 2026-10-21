// HTTP-facing services of the notifications module. The parent endpoints (preferences, devices,
// inbox) belong to the parent module; this module serves the school admin's notification log
// (GET /school/notifications, JSON page or CSV) — who was told what, on which channel, and why an
// event was skipped (preferences off, no parent, push disabled, …).
import type { ChannelOutcome, NotificationChannel, ParentTripEvent, NotificationEventDto, NotificationStatus, SchoolNotificationListQuery } from '@wimb/shared';
import type { Request, Response } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import * as repo from './logRepository.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function toEventDto(r: repo.LogRow): NotificationEventDto {
  const payload = isRecord(r.payload) ? r.payload : {};
  const recipients = typeof payload.recipients === 'number' ? payload.recipients : 0;
  const channels = isRecord(payload.channels) ? (payload.channels as Partial<Record<NotificationChannel, ChannelOutcome>>) : {};
  return {
    id: r.id,
    tripId: r.trip_id,
    tripDate: r.trip_date,
    direction: r.direction,
    busCode: r.bus_code,
    studentId: r.student_id,
    studentName: r.student_name,
    eventType: r.event_type as ParentTripEvent,
    channel: r.channel as NotificationChannel,
    status: r.status as NotificationStatus,
    recipients,
    channels,
    error: r.error,
    sentAt: r.sent_at,
    createdAt: r.created_at,
  };
}

const channelCell = (d: NotificationEventDto, c: NotificationChannel) => {
  const o = d.channels[c];
  return o ? `${o.status} ${o.delivered}/${o.targets}${o.error ? ` ${o.error}` : ''}` : '';
};

const CSV_COLUMNS: CsvColumn<NotificationEventDto>[] = [
  { header: 'Created at (UTC)', key: 'createdAt' },
  { header: 'Trip date', key: 'tripDate' },
  { header: 'Direction', key: 'direction' },
  { header: 'Bus', key: 'busCode' },
  { header: 'Student', key: 'studentName' },
  { header: 'Event', key: 'eventType' },
  { header: 'Status', key: 'status' },
  { header: 'Recipients', key: 'recipients' },
  { header: 'In-app', value: (d) => channelCell(d, 'in_app') },
  { header: 'Push', value: (d) => channelCell(d, 'push') },
  { header: 'SMS', value: (d) => channelCell(d, 'sms') },
  { header: 'Error', key: 'error' },
  { header: 'Sent at (UTC)', key: 'sentAt' },
];

function filterOf(q: SchoolNotificationListQuery): repo.LogFilter {
  return { tripId: q.tripId, studentId: q.studentId, eventTypes: q.eventType, statuses: q.status, direction: q.direction, from: q.from, to: q.to, q: q.q };
}

/** GET /school/notifications */
export async function listLog(req: Request, res: Response, q: SchoolNotificationListQuery): Promise<void> {
  const filter = filterOf(q);
  const { orderBy } = parseSort(q.sort, repo.SORT);
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<NotificationEventDto>(res, { fileName: 'notifications.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toEventDto));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  sendList(res, rows.map((r) => toEventDto(r as repo.LogRow)), listMeta({ page, limit, total }));
}
