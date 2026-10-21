// Buses service (BP §8.3 Buses, §13.3; contract §5): list with filters/sort/pagination/CSV, detail,
// create (plan limit), edit, status changes and soft delete (blocked by an in-progress trip,
// current student assignments or live schedules). Every write is audited in its transaction.
import type { BusDetail, BusListItem, BusStatus } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { conflict, invalidState, notFound } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import { optionalSignedUrl } from '../files/urls.js';
import { assertSubscriptionCapacity } from '../platform/index.js';
import * as assignmentsRepo from './assignmentsRepository.js';
import * as documentsRepo from './documentsRepository.js';
import { busAuditView, toBusListItem, toCurrentStaff, toDocumentDto } from './dto.js';
import * as imagesRepo from './imagesRepository.js';
import { signImages } from './imagesService.js';
import * as repo from './repository.js';
import type { BusListQuery, BusStatusBody, CreateBusBody, UpdateBusBody } from './schemas.js';

const SORT = {
  allowed: {
    code: 'b.code',
    displayName: 'b.display_name',
    registrationNo: 'b.registration_no',
    capacity: 'b.capacity',
    status: 'b.status',
    fuelType: 'b.fuel_type',
    vehicleType: 'b.vehicle_type',
    lastKnownOdometer: 'b.last_known_odometer',
    createdAt: 'b.created_at',
    updatedAt: 'b.updated_at',
  },
  defaultSort: 'code',
  tiebreaker: 'b.id',
};

const CSV_COLUMNS: CsvColumn<BusListItem>[] = [
  { header: 'Code', key: 'code' },
  { header: 'Name', key: 'displayName' },
  { header: 'Type', key: 'vehicleType' },
  { header: 'Registration', key: 'registrationNo' },
  { header: 'Capacity', key: 'capacity' },
  { header: 'Fuel', key: 'fuelType' },
  { header: 'Status', key: 'status' },
  { header: 'Make / model', key: 'makeModel' },
  { header: 'Year', key: 'manufactureYear' },
  { header: 'Colour', key: 'color' },
  { header: 'Odometer (km)', key: 'lastKnownOdometer' },
  { header: 'Primary driver', key: 'primaryDriverName' },
  { header: 'Conductor', key: 'conductorName' },
  { header: 'Expired documents', key: 'expiredDocuments' },
  { header: 'Expiring documents', key: 'expiringDocuments' },
  { header: 'On trip', value: (r) => (r.hasActiveTrip ? 'yes' : 'no') },
  { header: 'Created (UTC)', key: 'createdAt' },
];

function filterOf(q: BusListQuery): repo.BusFilter {
  return { statuses: q.status, fuelTypes: q.fuelType, vehicleTypes: q.vehicleType, hasPrimaryDriver: q.hasPrimaryDriver, documentStatus: q.documentStatus, q: q.q };
}

async function listItems(req: Request, rows: repo.BusListRow[]): Promise<BusListItem[]> {
  return Promise.all(rows.map(async (r) => toBusListItem(r, await optionalSignedUrl(req, r.cover_thumb_key))));
}

/** GET /school/buses — JSON page or CSV export. */
export async function list(req: Request, res: Response, q: BusListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, SORT);
  const filter = filterOf(q);
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<BusListItem>(res, { fileName: 'buses.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map((r) => toBusListItem(r, null)));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  sendList(res, await listItems(req, rows as repo.BusListRow[]), listMeta({ page, limit, total }));
}

async function listItem(tx: Tx, id: string): Promise<repo.BusListRow> {
  const row = await repo.findListRow(tx, id);
  if (!row) throw notFound('Bus not found.');
  return row;
}

/** GET /school/buses/:id — bus, images, current staff and current documents. */
export async function get(req: Request, id: string): Promise<BusDetail> {
  const { row, images, staff, documents } = await withRequestTenant(
    req,
    async (tx) => {
      const r = await listItem(tx, id);
      return {
        row: r,
        images: await imagesRepo.listImages(tx, id),
        staff: await assignmentsRepo.currentAssignments(tx, id),
        documents: await documentsRepo.listForBus(tx, id),
      };
    },
    { readOnly: true },
  );
  const signed = await signImages(req, images);
  return {
    ...toBusListItem(row, signed[0]?.thumbnailUrl ?? signed[0]?.url ?? null),
    images: signed,
    staff: toCurrentStaff(staff),
    documents: documents.map(toDocumentDto),
    activeTripId: row.active_trip_id,
  };
}

/** Status transition rules shared by PATCH /:id and PATCH /:id/status. */
async function assertStatusChange(tx: Tx, bus: repo.BusRow, next: BusStatus): Promise<void> {
  if (next === bus.status) return;
  if (next !== 'active') {
    const blockers = await repo.deleteBlockers(tx, bus.id);
    if (blockers.active_trip_id) throw invalidState('The bus is on a trip. End the trip before changing its status.', { activeTripId: blockers.active_trip_id });
  }
}

/** POST /school/buses */
export async function create(req: Request, body: CreateBusBody): Promise<BusListItem> {
  return withRequestTenant(req, async (tx) => {
    // Plan limit (contract §9): every non-deleted bus counts — one rule with the platform usage views.
    await assertSubscriptionCapacity(tx, 'buses', 1);
    const bus = await repo.insertBus(tx, body);
    await audit.log(tx, { action: 'bus.create', entityType: 'bus', entityId: bus.id, new: busAuditView(bus) });
    return toBusListItem(await listItem(tx, bus.id), null);
  });
}

/** PATCH /school/buses/:id */
export async function update(req: Request, id: string, body: UpdateBusBody): Promise<BusListItem> {
  return withRequestTenant(req, async (tx) => {
    const before = await repo.lockBus(tx, id);
    if (!before) throw notFound('Bus not found.');
    if (body.status) await assertStatusChange(tx, before, body.status);
    const after = await repo.updateBus(tx, id, body);
    const diff = changedFields(busAuditView(before), busAuditView(after));
    if (Object.keys(diff.new).length) await audit.log(tx, { action: 'bus.update', entityType: 'bus', entityId: id, ...diff });
    return toBusListItem(await listItem(tx, id), null);
  });
}

/** PATCH /school/buses/:id/status */
export async function changeStatus(req: Request, id: string, body: BusStatusBody): Promise<BusListItem> {
  return withRequestTenant(req, async (tx) => {
    const before = await repo.lockBus(tx, id);
    if (!before) throw notFound('Bus not found.');
    if (before.status !== body.status) {
      await assertStatusChange(tx, before, body.status);
      await repo.updateBus(tx, id, { status: body.status });
      await audit.log(tx, { action: 'bus.status_change', entityType: 'bus', entityId: id, old: { status: before.status }, new: { status: body.status, reason: body.reason ?? null } });
    }
    return toBusListItem(await listItem(tx, id), null);
  });
}

/** DELETE /school/buses/:id — soft delete; history (trips, documents, assignments) is kept. */
export async function remove(req: Request, id: string): Promise<{ id: string; deleted: true }> {
  return withRequestTenant(req, async (tx) => {
    const bus = await repo.lockBus(tx, id);
    if (!bus) throw notFound('Bus not found.');
    const blockers = await repo.deleteBlockers(tx, id);
    if (blockers.active_trip_id) throw invalidState('The bus is on a trip and cannot be deleted.', { activeTripId: blockers.active_trip_id });
    if (blockers.student_assignments > 0 || blockers.schedules > 0) {
      throw conflict('Move the students and schedules of this bus to another bus before deleting it.', {
        studentAssignments: blockers.student_assignments,
        schedules: blockers.schedules,
      });
    }
    const effects = await repo.softDelete(tx, id, 'Bus deleted');
    await audit.log(tx, {
      action: 'bus.delete',
      entityType: 'bus',
      entityId: id,
      old: busAuditView(bus),
      new: { staffAssignmentsClosed: effects.staff_closed, routeAssignmentsClosed: effects.routes_closed, tripsCancelled: effects.trips_cancelled },
    });
    return { id, deleted: true as const };
  });
}
