// Routes module schemas (BP §6.2 ROUTES/STOPS/SCHEDULES, §8.3 Routes/Stops + Schedules, §13.3 Routes &
// Stops; contract §2 Routing). Shared by the backend validators and the web admin forms (route editor,
// schedule wizard). Unknown keys (e.g. school_id) are stripped.
import { z } from 'zod';
import { DIRECTIONS, type Direction, type PolylineSource } from '../enums.js';
import { exportFormat, hhmm, isoDate, isoDateTime, listQueryShape, optionalText, queryBool, queryEnumList, queryInt, text, uuid } from './common.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const csvOnly = exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv');
const atLeastOne = { message: 'Provide at least one field to change' };
const hasChange = (b: Record<string, unknown>) => Object.values(b).some((v) => v !== undefined);

/** Live stops per route (the map editor and Google routing chunks stay fast). */
export const MAX_STOPS_PER_ROUTE = 60;
/** Stop geofence radius (metres): default and bounds (mirrors the stops CHECK constraint). */
export const DEFAULT_ARRIVAL_RADIUS_M = 100;
export const MIN_ARRIVAL_RADIUS_M = 20;
export const MAX_ARRIVAL_RADIUS_M = 2000;
/** The school is added as the route's end (morning) / start (afternoon) unless a stop lies this close to it. */
export const SCHOOL_ENDPOINT_MERGE_M = 150;
/** Schedule overlap window when nothing better is known about a route's duration (minutes). */
export const DEFAULT_TRIP_DURATION_MIN = 60;
export const MIN_TRIP_DURATION_MIN = 15;
export const MAX_TRIP_DURATION_MIN = 240;
/** Dwell time assumed per stop on top of the driving time of a computed polyline (seconds). */
export const STOP_DWELL_S = 60;
/** ISO weekdays: 1 = Monday … 7 = Sunday. */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

// ── routes ───────────────────────────────────────────────────────────────────
const routeFields = {
  code: text(40),
  name: optionalText(120),
  direction: z.enum(DIRECTIONS),
  description: optionalText(1000),
  isActive: z.boolean().optional(),
};

export const createRouteBody = z.object(routeFields);
export type CreateRouteBody = z.infer<typeof createRouteBody>;

export const updateRouteBody = z.object(routeFields).partial().refine(hasChange, atLeastOne);
export type UpdateRouteBody = z.infer<typeof updateRouteBody>;

export const routeListQuery = z.object({
  ...listQueryShape,
  format: csvOnly,
  direction: queryEnumList([...DIRECTIONS]),
  isActive: queryBool(),
  /** true → routes with at least one bus assigned now; false → routes without one. */
  hasBus: queryBool(),
  /** Routes the bus is assigned to now. */
  busId: z.preprocess(emptyToUndefined, uuid().optional()),
});
export type RouteListQuery = z.infer<typeof routeListQuery>;

// ── stops ────────────────────────────────────────────────────────────────────
const latitude = () => z.number({ required_error: 'Required', invalid_type_error: 'Must be a number' }).finite().min(-90).max(90);
const longitude = () => z.number({ required_error: 'Required', invalid_type_error: 'Must be a number' }).finite().min(-180).max(180);
const arrivalRadius = () => z.number({ invalid_type_error: 'Must be a number' }).int().min(MIN_ARRIVAL_RADIUS_M).max(MAX_ARRIVAL_RADIUS_M);
const expectedTime = () => z.preprocess((v) => (v === '' ? null : v), hhmm().nullable().optional());

const stopFields = {
  name: text(200),
  code: optionalText(40),
  landmark: optionalText(200),
  latitude: latitude(),
  longitude: longitude(),
  /** Planned arrival at the stop ('HH:mm', school-local). */
  expectedTime: expectedTime(),
  arrivalRadiusM: arrivalRadius().optional(),
};

export const createStopBody = z.object({
  ...stopFields,
  /** 1-based position; later stops move down. Omitted → appended at the end. */
  sequence: z.number({ invalid_type_error: 'Must be a number' }).int().min(1).max(MAX_STOPS_PER_ROUTE).optional(),
});
export type CreateStopBody = z.infer<typeof createStopBody>;

export const updateStopBody = z.object(stopFields).partial().refine(hasChange, atLeastOne);
export type UpdateStopBody = z.infer<typeof updateStopBody>;

export const reorderStopsBody = z.object({
  /** Every live stop of the route exactly once, in the new order. */
  stopIds: z
    .array(uuid())
    .min(1)
    .max(MAX_STOPS_PER_ROUTE)
    .refine((ids) => new Set(ids).size === ids.length, 'A stop may appear only once'),
});
export type ReorderStopsBody = z.infer<typeof reorderStopsBody>;

// ── bus ↔ route assignments ──────────────────────────────────────────────────
export const assignRouteBusBody = z.object({
  busId: uuid(),
  /** Start of the assignment (default: now; not in the future). */
  effectiveFrom: isoDateTime().optional(),
  note: optionalText(500),
});
export type AssignRouteBusBody = z.infer<typeof assignRouteBusBody>;

export const unassignRouteBusBody = z.object({
  busId: uuid(),
  /** End of the assignment (default: now; not in the future, not before it started). */
  effectiveTo: isoDateTime().optional(),
  note: optionalText(500),
});
export type UnassignRouteBusBody = z.infer<typeof unassignRouteBusBody>;

export const busRouteAssignmentQuery = z.object({
  page: listQueryShape.page,
  limit: listQueryShape.limit,
  sort: listQueryShape.sort,
  format: csvOnly,
  routeId: z.preprocess(emptyToUndefined, uuid().optional()),
  busId: z.preprocess(emptyToUndefined, uuid().optional()),
  direction: queryEnumList([...DIRECTIONS]),
  /** true → open now; false → ended (or not started yet). */
  current: queryBool(),
});
export type BusRouteAssignmentQuery = z.infer<typeof busRouteAssignmentQuery>;

// ── trip schedules ───────────────────────────────────────────────────────────
/** ISO weekdays, de-duplicated and sorted ([5, 1, 1] → [1, 5]). */
export const daysOfWeek = () =>
  z
    .array(z.number({ invalid_type_error: 'Must be a weekday number 1–7' }).int().min(1).max(7), { invalid_type_error: 'Must be a list of weekdays' })
    .min(1, 'Pick at least one weekday')
    .max(7)
    .transform((d) => [...new Set(d)].sort((a, b) => a - b));

const nullableDate = () => z.preprocess((v) => (v === '' ? null : v), isoDate().nullable().optional());
const datesInOrder = (b: { validFrom?: string | null; validTo?: string | null }) => !b.validFrom || !b.validTo || b.validTo >= b.validFrom;
const DATES_MESSAGE = { message: 'validTo must not be before validFrom', path: ['validTo'] };

const scheduleFields = {
  busId: uuid(),
  routeId: uuid(),
  /** Must match the route's direction; omitted → the route's direction. */
  direction: z.enum(DIRECTIONS).optional(),
  name: optionalText(120),
  /** 'HH:mm', school-local. */
  plannedStartTime: hhmm(),
  daysOfWeek: daysOfWeek(),
  /** Inclusive first day (null = already valid). */
  validFrom: nullableDate(),
  /** Inclusive last day (null = open-ended). */
  validTo: nullableDate(),
  isActive: z.boolean().optional(),
};

export const createTripScheduleBody = z.object(scheduleFields).refine(datesInOrder, DATES_MESSAGE);
export type CreateTripScheduleBody = z.infer<typeof createTripScheduleBody>;

export const updateTripScheduleBody = z.object(scheduleFields).partial().refine(hasChange, atLeastOne).refine(datesInOrder, DATES_MESSAGE);
export type UpdateTripScheduleBody = z.infer<typeof updateTripScheduleBody>;

export const tripScheduleListQuery = z.object({
  ...listQueryShape,
  format: csvOnly,
  busId: z.preprocess(emptyToUndefined, uuid().optional()),
  routeId: z.preprocess(emptyToUndefined, uuid().optional()),
  direction: queryEnumList([...DIRECTIONS]),
  isActive: queryBool(),
  /** Schedules running on this ISO weekday. */
  day: queryInt(1, 7),
  /** Schedules whose validity includes this date. */
  validOn: z.preprocess(emptyToUndefined, isoDate().optional()),
});
export type TripScheduleListQuery = z.infer<typeof tripScheduleListQuery>;

// ── DTOs (API responses) ─────────────────────────────────────────────────────
export interface RouteBusRef {
  busId: string;
  busCode: string;
  busName: string | null;
  registrationNo: string;
  assignmentId: string;
  validFrom: string;
}

export interface RouteListItem {
  id: string;
  code: string;
  name: string | null;
  direction: Direction;
  description: string | null;
  isActive: boolean;
  stopCount: number;
  /** Expected time of the first / last stop ('HH:mm'). */
  firstStopTime: string | null;
  lastStopTime: string | null;
  /** Buses assigned to the route now. */
  buses: RouteBusRef[];
  activeScheduleCount: number;
  /** Students with a current assignment on this route. */
  studentCount: number;
  polylineSource: PolylineSource | null;
  polylineComputedAt: string | null;
  distanceM: number | null;
  durationS: number | null;
  hasActiveTrip: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StopDto {
  id: string;
  routeId: string;
  sequence: number;
  name: string;
  code: string | null;
  landmark: string | null;
  latitude: number;
  longitude: number;
  expectedTime: string | null;
  arrivalRadiusM: number;
  /** Students with a current assignment at this stop. */
  studentCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Hints for the route editor (never block saving). */
export const ROUTE_WARNINGS = ['too_few_stops', 'expected_times_out_of_order', 'polyline_missing', 'polyline_straight'] as const;
export type RouteWarning = (typeof ROUTE_WARNINGS)[number];

export interface RouteDetail extends RouteListItem {
  polylineEncoded: string | null;
  stops: StopDto[];
  /** School location used as the route's end (morning) / start (afternoon); null when not set. */
  school: { latitude: number; longitude: number } | null;
  activeTripId: string | null;
  warnings: RouteWarning[];
}

export interface RoutingLeg {
  fromStopId: string | null;
  toStopId: string | null;
  distanceM: number;
  durationS: number;
}

export interface RecomputePolylineResult {
  route: RouteDetail;
  routing: {
    source: PolylineSource;
    fallbackReason: 'no_api_key' | 'api_error' | 'too_few_points' | null;
    distanceM: number;
    durationS: number;
    includesSchool: boolean;
    /** One leg per consecutive point pair; null stop ids mark the school endpoint. */
    legs: RoutingLeg[];
  };
}

export interface BusRouteAssignmentItem {
  id: string;
  busId: string;
  busCode: string;
  busName: string | null;
  routeId: string;
  routeCode: string;
  routeName: string | null;
  direction: Direction;
  validFrom: string;
  validTo: string | null;
  isCurrent: boolean;
  createdByName: string | null;
  createdAt: string;
}

export interface AssignRouteBusResult {
  action: 'assigned' | 'unchanged' | 'unassigned';
  assignment: BusRouteAssignmentItem;
  buses: RouteBusRef[];
}

export interface TripScheduleItem {
  id: string;
  name: string | null;
  busId: string;
  busCode: string;
  busName: string | null;
  routeId: string;
  routeCode: string;
  routeName: string | null;
  direction: Direction;
  plannedStartTime: string;
  daysOfWeek: number[];
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  /** Overlap window used for the same-bus check (minutes) and its end ('HH:mm', may pass midnight → '+1'). */
  estimatedDurationMin: number;
  estimatedEndTime: string;
  createdAt: string;
  updatedAt: string;
}

export interface TripScheduleConflict {
  scheduleId: string;
  name: string | null;
  routeCode: string;
  direction: Direction;
  plannedStartTime: string;
  estimatedEndTime: string;
  sharedDays: number[];
}
