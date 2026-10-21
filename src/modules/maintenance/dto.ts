// Maintenance DTOs (camelCase JSON) and the compact audit view.
import type { DueListStatus, MaintenanceDueItem, MaintenanceDueStatus, MaintenanceLogDto } from '@wimb/shared';
import { fileDto, num, round } from '../fuel/dto.js';
import { odometerFlags } from '../fuel/odometer.js';
import type { DueRow } from './dueRepository.js';
import type { MaintenanceLogRow } from './repository.js';

const km = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : round(n, 1);
};

export function toDto(r: MaintenanceLogRow): MaintenanceLogDto {
  return {
    id: r.id,
    busId: r.bus_id,
    busCode: r.bus_code,
    busRegistrationNo: r.bus_registration_no,
    busOdometer: km(r.bus_odometer),
    serviceType: r.service_type,
    serviceDate: r.service_date,
    cost: num(r.cost),
    odometer: km(r.odometer),
    vendor: r.vendor,
    notes: r.notes,
    invoice: fileDto(r.invoice_file_id, r.invoice_name, r.invoice_mime, r.invoice_size, r.invoice_has_thumb),
    nextDueDate: r.next_due_date,
    nextDueKm: km(r.next_due_km),
    dueStatus: r.due_status as MaintenanceDueStatus,
    daysToDue: num(r.days_to_due),
    kmToDue: km(r.km_to_due),
    odometerFlags: odometerFlags(r.odometer, r.prev_reading, r.next_reading),
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toDueItem(r: DueRow): MaintenanceDueItem {
  return {
    maintenanceLogId: r.id,
    busId: r.bus_id,
    busCode: r.bus_code,
    registrationNo: r.registration_no,
    busStatus: r.bus_status,
    busOdometer: km(r.bus_odometer),
    serviceType: r.service_type,
    lastServiceDate: r.service_date,
    lastServiceOdometer: km(r.odometer),
    vendor: r.vendor,
    nextDueDate: r.next_due_date,
    nextDueKm: km(r.next_due_km),
    daysToDue: num(r.days_to_due),
    kmToDue: km(r.km_to_due),
    status: r.status as DueListStatus,
    reason: (r.reason as 'date' | 'km' | null) ?? null,
  };
}

/** Audit view: business fields only (no derived values). */
export function auditView(r: MaintenanceLogRow): Record<string, unknown> {
  return {
    busId: r.bus_id,
    busCode: r.bus_code,
    serviceType: r.service_type,
    serviceDate: r.service_date,
    cost: num(r.cost),
    odometer: num(r.odometer),
    vendor: r.vendor,
    notes: r.notes,
    invoiceFileId: r.invoice_file_id,
    nextDueDate: r.next_due_date,
    nextDueKm: num(r.next_due_km),
  };
}
