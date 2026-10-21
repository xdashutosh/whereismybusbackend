// Row → JSON mappers of the routes module (DB snake_case → API camelCase, contract §5). TIME columns
// arrive as 'HH:mm:ss' strings and leave as 'HH:mm'; NUMERIC coordinates arrive as numbers.
import type { BusRouteAssignmentItem, Direction, PolylineSource, RouteBusRef, RouteListItem, RouteWarning, StopDto, TripScheduleItem } from '@wimb/shared';

/** 'HH:mm:ss' → 'HH:mm' (null stays null). */
export const hhmmOf = (t: string | null | undefined): string | null => (t ? t.slice(0, 5) : null);

export interface RouteRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string | null;
  direction: string;
  description: string | null;
  is_active: boolean;
  polyline_encoded: string | null;
  polyline_source: string | null;
  polyline_computed_at: string | null;
  distance_m: number | null;
  duration_s: number | null;
  created_at: string;
  updated_at: string;
}

/** List/detail row: the route plus counters computed in the same statement. */
export interface RouteListRow extends RouteRow {
  stop_count: number;
  first_stop_time: string | null;
  last_stop_time: string | null;
  buses: { bus_id: string; bus_code: string; bus_name: string | null; registration_no: string; assignment_id: string; valid_from: string }[] | null;
  active_schedule_count: number;
  student_count: number;
  active_trip_id: string | null;
}

export function toBusRefs(rows: RouteListRow['buses']): RouteBusRef[] {
  return (rows ?? []).map((b) => ({
    busId: b.bus_id,
    busCode: b.bus_code,
    busName: b.bus_name,
    registrationNo: b.registration_no,
    assignmentId: b.assignment_id,
    validFrom: b.valid_from,
  }));
}

export function toRouteListItem(r: RouteListRow): RouteListItem {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    direction: r.direction as Direction,
    description: r.description,
    isActive: r.is_active,
    stopCount: r.stop_count ?? 0,
    firstStopTime: hhmmOf(r.first_stop_time),
    lastStopTime: hhmmOf(r.last_stop_time),
    buses: toBusRefs(r.buses),
    activeScheduleCount: r.active_schedule_count ?? 0,
    studentCount: r.student_count ?? 0,
    polylineSource: r.polyline_source as PolylineSource | null,
    polylineComputedAt: r.polyline_computed_at,
    distanceM: r.distance_m,
    durationS: r.duration_s,
    hasActiveTrip: r.active_trip_id !== null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Audit snapshot of a route (plain columns only). */
export function routeAuditView(r: Record<string, unknown>) {
  return { code: r.code, name: r.name, direction: r.direction, description: r.description, isActive: r.is_active };
}

export interface StopRow extends Record<string, unknown> {
  id: string;
  route_id: string;
  sequence: number;
  name: string;
  code: string | null;
  landmark: string | null;
  latitude: number;
  longitude: number;
  expected_time: string | null;
  arrival_radius_m: number;
  student_count?: number;
  created_at: string;
  updated_at: string;
}

export function toStopDto(r: StopRow): StopDto {
  return {
    id: r.id,
    routeId: r.route_id,
    sequence: r.sequence,
    name: r.name,
    code: r.code,
    landmark: r.landmark,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    expectedTime: hhmmOf(r.expected_time),
    arrivalRadiusM: r.arrival_radius_m,
    studentCount: r.student_count ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Audit snapshot of a stop. */
export function stopAuditView(r: StopRow) {
  return {
    routeId: r.route_id,
    sequence: r.sequence,
    name: r.name,
    code: r.code,
    landmark: r.landmark,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    expectedTime: hhmmOf(r.expected_time),
    arrivalRadiusM: r.arrival_radius_m,
  };
}

/** Editor hints (BP §13.3 route editor); pure function of the route and its ordered stops. */
export function routeWarnings(route: Pick<RouteRow, 'polyline_source'>, stops: Pick<StopRow, 'expected_time'>[], pointCount: number): RouteWarning[] {
  const warnings: RouteWarning[] = [];
  if (stops.length < 2) warnings.push('too_few_stops');
  const times = stops.map((s) => s.expected_time).filter((t): t is string => !!t);
  if (times.some((t, i) => i > 0 && t < times[i - 1]!)) warnings.push('expected_times_out_of_order');
  if (!route.polyline_source && pointCount >= 2) warnings.push('polyline_missing');
  if (route.polyline_source === 'straight') warnings.push('polyline_straight');
  return warnings;
}

export interface AssignmentRow extends Record<string, unknown> {
  id: string;
  bus_id: string;
  bus_code: string;
  bus_name: string | null;
  route_id: string;
  route_code: string;
  route_name: string | null;
  direction: string;
  valid_from: string;
  valid_to: string | null;
  is_current: boolean;
  created_by_name: string | null;
  created_at: string;
}

export function toAssignmentItem(r: AssignmentRow): BusRouteAssignmentItem {
  return {
    id: r.id,
    busId: r.bus_id,
    busCode: r.bus_code,
    busName: r.bus_name,
    routeId: r.route_id,
    routeCode: r.route_code,
    routeName: r.route_name,
    direction: r.direction as Direction,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    isCurrent: r.is_current,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  };
}

export interface ScheduleRow extends Record<string, unknown> {
  id: string;
  name: string | null;
  bus_id: string;
  bus_code: string;
  bus_name: string | null;
  route_id: string;
  route_code: string;
  route_name: string | null;
  direction: string;
  planned_start_time: string;
  days_of_week: number[];
  valid_from: string | null;
  valid_to: string | null;
  is_active: boolean;
  estimated_duration_min: number;
  created_at: string;
  updated_at: string;
}

/** Start + duration as 'HH:mm', suffixed '+1' when the window passes midnight. */
export function endTimeOf(start: string, durationMin: number): string {
  const [h, m] = start.split(':').map(Number) as [number, number];
  const total = h * 60 + m + durationMin;
  const day = Math.floor(total / 1440);
  const mins = total % 1440;
  const hhmm = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return day > 0 ? `${hhmm}+${day}` : hhmm;
}

export function toScheduleItem(r: ScheduleRow): TripScheduleItem {
  const start = hhmmOf(r.planned_start_time)!;
  return {
    id: r.id,
    name: r.name,
    busId: r.bus_id,
    busCode: r.bus_code,
    busName: r.bus_name,
    routeId: r.route_id,
    routeCode: r.route_code,
    routeName: r.route_name,
    direction: r.direction as Direction,
    plannedStartTime: start,
    daysOfWeek: (r.days_of_week ?? []).map(Number),
    validFrom: r.valid_from,
    validTo: r.valid_to,
    isActive: r.is_active,
    estimatedDurationMin: r.estimated_duration_min,
    estimatedEndTime: endTimeOf(start, r.estimated_duration_min),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Audit snapshot of a schedule. */
export function scheduleAuditView(r: Record<string, unknown>) {
  return {
    name: r.name,
    busId: r.bus_id,
    routeId: r.route_id,
    direction: r.direction,
    plannedStartTime: hhmmOf(r.planned_start_time as string | null),
    daysOfWeek: r.days_of_week,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    isActive: r.is_active,
  };
}
