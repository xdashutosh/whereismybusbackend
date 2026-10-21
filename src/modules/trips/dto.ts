// Row → DTO mapping of the trips module (snake_case DB → camelCase API).
import type { AlertType, DriverTrip, OdometerCorrection, TripListItem } from '@wimb/shared';
import type { TripRow } from './repository.js';

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function toDriverTrip(t: TripRow, boundDeviceId: string | null): DriverTrip {
  return {
    id: t.id,
    tripType: t.trip_type,
    direction: t.direction,
    tripDate: t.trip_date,
    status: t.status,
    busId: t.bus_id,
    busCode: t.bus_code_snapshot,
    busRegistrationNo: t.bus_registration_snapshot,
    routeId: t.route_id,
    routeCode: t.route_code_snapshot,
    routeName: t.route_name_snapshot,
    driverStaffId: t.driver_staff_id,
    driverName: t.driver_name_snapshot,
    conductorStaffId: t.conductor_staff_id,
    conductorName: t.conductor_name_snapshot,
    purpose: t.purpose,
    plannedStartAt: t.planned_start_at,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    startOdometer: num(t.start_odometer),
    endOdometer: num(t.end_odometer),
    distanceOdometerKm: num(t.distance_odometer_km),
    distanceGpsKm: num(t.distance_gps_km),
    interruptedAt: t.interrupted_at,
    cancelReason: t.cancel_reason,
    closeReason: t.close_reason,
    onThisDevice: boundDeviceId !== null && t.device_id === boundDeviceId,
  };
}

function correctionCount(raw: unknown): number {
  const history = (raw as Partial<OdometerCorrection> | null)?.history;
  return Array.isArray(history) ? history.length : 0;
}

export interface TripListRow extends TripRow {
  alert_count: number;
  open_alert_count: number;
  alert_types: AlertType[] | null;
}

export function toListItem(t: TripListRow): TripListItem {
  return {
    id: t.id,
    tripDate: t.trip_date,
    tripType: t.trip_type,
    direction: t.direction,
    status: t.status,
    busId: t.bus_id,
    busCode: t.bus_code_snapshot,
    busRegistrationNo: t.bus_registration_snapshot,
    routeId: t.route_id,
    routeCode: t.route_code_snapshot,
    routeName: t.route_name_snapshot,
    driverStaffId: t.driver_staff_id,
    driverName: t.driver_name_snapshot,
    conductorStaffId: t.conductor_staff_id,
    conductorName: t.conductor_name_snapshot,
    purpose: t.purpose,
    plannedStartAt: t.planned_start_at,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    startOdometer: num(t.start_odometer),
    endOdometer: num(t.end_odometer),
    distanceOdometerKm: num(t.distance_odometer_km),
    distanceGpsKm: num(t.distance_gps_km),
    odometerCorrected: correctionCount(t.odometer_correction) > 0,
    interrupted: t.interrupted_at !== null,
    alertCount: Number(t.alert_count ?? 0),
    openAlertCount: Number(t.open_alert_count ?? 0),
    alertTypes: t.alert_types ?? [],
  };
}

/** Compact audit view of a trip (no snapshots of unrelated columns). */
export function tripAuditView(t: Partial<TripRow>) {
  return {
    status: t.status,
    busId: t.bus_id,
    routeId: t.route_id,
    tripType: t.trip_type,
    direction: t.direction,
    tripDate: t.trip_date,
    driverStaffId: t.driver_staff_id,
    conductorStaffId: t.conductor_staff_id,
    startOdometer: num(t.start_odometer),
    endOdometer: num(t.end_odometer),
    distanceOdometerKm: num(t.distance_odometer_km),
    distanceGpsKm: num(t.distance_gps_km),
    deviceId: t.device_id,
    purpose: t.purpose,
  };
}
