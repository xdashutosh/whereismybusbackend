// Fuel log DTOs (camelCase JSON) and the compact audit view.
import { fuelUnitOf, type FuelLogDto, type FuelType, type FuelUnit, type LogFileDto } from '@wimb/shared';
import { odometerFlags } from './odometer.js';
import type { FuelLogRow } from './repository.js';

export const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const round = (v: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Attached file summary (never the storage key; download through GET /files/:id/url). */
export function fileDto(id: string | null, name: unknown, mime: unknown, size: unknown, thumb: unknown): LogFileDto | null {
  if (!id) return null;
  return { id, fileName: (name as string | null) ?? null, contentType: (mime as string | null) ?? 'application/octet-stream', sizeBytes: num(size), hasThumbnail: thumb === true };
}

export function toDto(r: FuelLogRow): FuelLogDto {
  const litres = Number(r.litres);
  const cost = Number(r.cost);
  const distance = num(r.distance_km);
  const spanLitres = num(r.span_litres);
  const spanCost = num(r.span_cost);
  return {
    id: r.id,
    busId: r.bus_id,
    busCode: r.bus_code,
    busRegistrationNo: r.bus_registration_no,
    fuelDate: r.fuel_date,
    odometer: num(r.odometer),
    litres,
    cost,
    pricePerLitre: litres > 0 ? round(cost / litres) : 0,
    fuelType: (r.fuel_type as FuelType | null) ?? null,
    unit: (r.unit as FuelUnit | undefined) ?? fuelUnitOf(r.fuel_type),
    station: r.station,
    notes: r.notes,
    bill: fileDto(r.bill_file_id, r.bill_name, r.bill_mime, r.bill_size, r.bill_has_thumb),
    distanceKm: distance === null ? null : round(distance, 1),
    spanLitres: distance === null ? null : spanLitres,
    spanCost: distance === null ? null : spanCost,
    kmPerLitre: distance !== null && spanLitres ? round(distance / spanLitres) : null,
    costPerKm: distance !== null && distance > 0 && spanCost !== null ? round(spanCost / distance) : null,
    odometerFlags: odometerFlags(r.odometer, r.prev_reading, r.next_reading),
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Audit view: business fields only (no derived values). */
export function auditView(r: FuelLogRow): Record<string, unknown> {
  return {
    busId: r.bus_id,
    busCode: r.bus_code,
    fuelDate: r.fuel_date,
    odometer: num(r.odometer),
    litres: Number(r.litres),
    cost: Number(r.cost),
    fuelType: r.fuel_type,
    station: r.station,
    billFileId: r.bill_file_id,
    notes: r.notes,
  };
}
