// Event subscriptions of the notifications engine (BP §11.2 triggers). Registered at import time in
// every process that can emit them (the API through router.ts, the worker through jobs.ts listed in
// src/jobs/index.ts). Listeners only decide and queue: the work runs in jobs with retries.
//   trip.status_changed → in_progress   trip_started         (students on that bus + direction)
//   trip.not_started                    trip_not_started     (trips module emits it only when the
//                                                             school enabled notify_trip_not_started)
//   trip.interrupted                    trip_interrupted     (BP §10.4 breakdown, driver-reported)
//   trip.status_changed → cancelled     trip_cancelled       (a running trip, or today's scheduled trip;
//     (from in_progress / scheduled)                          school holidays / schedule edits excluded)
//   tracking.left_school                bus_left_school
//   tracking.stop_arrived               arrived_at_stop      (students of that stop)
//   tracking.eta_updated                approaching_stop     (ETA to the stop ≤ approaching_stop_minutes)
//                                       trip_delayed         (ETA later than the timetable + delay threshold)
//   announcement.published / changed    announcement-deliver when due (a scheduled one is delivered by
//                                       the per-minute announcement-sweep once publishedAt is reached)
// ETA updates arrive for every live batch, so their candidates are deduplicated per (trip, event,
// stop) with an atomic kv marker before anything is queued; notification_events stays the authority.
import crypto from 'node:crypto';
import type { ParentTripEvent, TripEta } from '@wimb/shared';
import { withSchoolSystem } from '../../db/tenant.js';
import { events } from '../../shared/events.js';
import { kv as defaultKv, kvKey, type KvStore } from '../../shared/kv.js';
import { logger as rootLogger } from '../../shared/logger.js';
import type { AnnouncementEventPayload } from '../school/index.js';
import type { TrackingStopEvent } from '../tracking/index.js';
import type { TripNotStartedPayload, TripStatusPayload } from '../trips/events.js';
import { loadSchoolSettings } from '../school/index.js';
import type { AnnouncementAction, AnnouncementJobPayload } from './announcements.js';
import { ANNOUNCEMENT_JOB, DISPATCH_JOB } from './constants.js';
import type { TripDispatchPayload } from './dispatch.js';
import '../school/events.js';
import '../tracking/events.js';
import '../trips/events.js';

const log = rootLogger.child({ module: 'notifications.listeners' });

/** kv marker lifetime of an ETA-based candidate (longer than any trip). */
export const ETA_MARKER_TTL_S = 12 * 3600;
/** An announcement due within this skew is queued at once (matches the delivery's own 5-s window). */
export const ANNOUNCEMENT_DUE_SKEW_MS = 5_000;
/** School thresholds are cached this long per process (dropped on school.settings_changed). */
export const THRESHOLD_CACHE_MS = 60_000;

export interface EtaThresholds {
  approachingStopMinutes: number;
  delayThresholdMin: number;
}

export interface EtaCandidates {
  approaching: Record<string, number>;
  delayed: Record<string, number>;
}

/**
 * Pure: stops whose ETA is within the approaching window (quality good or degraded — a degraded ETA
 * uses the speed floor, so it errs late) and stops predicted later than their timetable time by
 * more than the delay threshold (good quality only, so no false "delayed" alert from a cold start).
 */
export function etaCandidates(eta: TripEta | null | undefined, t: EtaThresholds): EtaCandidates {
  const out: EtaCandidates = { approaching: {}, delayed: {} };
  if (!eta || eta.quality === 'unavailable') return out;
  const ref = Date.parse(eta.computedAt);
  for (const s of eta.stops) {
    const minutes = (Date.parse(s.etaAt) - ref) / 60_000;
    if (Number.isFinite(minutes) && minutes <= t.approachingStopMinutes) out.approaching[s.stopId] = Math.max(1, Math.ceil(minutes));
    if (eta.quality === 'good' && s.delayMin !== null && s.delayMin > t.delayThresholdMin) out.delayed[s.stopId] = Math.max(1, Math.round(s.delayMin));
  }
  return out;
}

const thresholdCache = new Map<string, { value: EtaThresholds; expires: number }>();

export async function etaThresholds(schoolId: string, nowMs = Date.now()): Promise<EtaThresholds> {
  const hit = thresholdCache.get(schoolId);
  if (hit && hit.expires > nowMs) return hit.value;
  const s = await withSchoolSystem(schoolId, (tx) => loadSchoolSettings(tx), { readOnly: true });
  const value = { approachingStopMinutes: s.approachingStopMinutes, delayThresholdMin: s.tripDelayThresholdMin };
  thresholdCache.set(schoolId, { value, expires: nowMs + THRESHOLD_CACHE_MS });
  return value;
}

export function clearThresholdCache(schoolId?: string): void {
  if (schoolId) thresholdCache.delete(schoolId);
  else thresholdCache.clear();
}

/** Job id safe for BullMQ (no ':'), deterministic per (event, trip, stops). */
export function dispatchJobId(p: Pick<TripDispatchPayload, 'event' | 'tripId' | 'stopIds'>): string {
  const stops = p.stopIds?.length ? `-${crypto.createHash('sha1').update([...p.stopIds].sort().join(',')).digest('hex').slice(0, 16)}` : '';
  return `notif-${p.event}-${p.tripId}${stops}`;
}

async function enqueue(name: string, payload: unknown, opts: { jobId: string; delayMs?: number }): Promise<void> {
  // Lazy: jobs/index imports this module's job definitions (a static import would be a cycle).
  const { jobs } = await import('../../jobs/index.js');
  await jobs.enqueue(name, payload, opts);
}

export async function enqueueDispatch(p: TripDispatchPayload): Promise<void> {
  try {
    await enqueue(DISPATCH_JOB, p, { jobId: dispatchJobId(p) });
  } catch (err) {
    log.error({ err, schoolId: p.schoolId, tripId: p.tripId, event: p.event }, 'Could not queue a parent notification');
  }
}

export async function onTripStatusChanged(p: TripStatusPayload): Promise<void> {
  if (p.status !== 'in_progress' || p.previousStatus === 'in_progress' || p.tripType !== 'school' || !p.direction) return;
  await enqueueDispatch({ schoolId: p.schoolId, tripId: p.tripId, event: 'trip_started', at: p.at });
}

/** Trips cancelled by these automatic reasons are calendar changes, not service disruptions. */
const AUTOMATIC_CANCEL = /^(School holiday: |Schedule (deactivated|changed|deleted)$)/;

export async function onTripInterrupted(p: TripStatusPayload): Promise<void> {
  if (p.tripType !== 'school' || !p.direction) return;
  await enqueueDispatch({ schoolId: p.schoolId, tripId: p.tripId, event: 'trip_interrupted', at: p.at });
}

/** A school trip cancelled while running, or before its start on its own date (BP §10.4). */
export async function onTripCancelled(p: TripStatusPayload): Promise<void> {
  if (p.status !== 'cancelled' || p.tripType !== 'school' || !p.direction) return;
  if (p.previousStatus !== 'in_progress' && p.previousStatus !== 'scheduled') return;
  if (p.reason && AUTOMATIC_CANCEL.test(p.reason)) return;
  await enqueueDispatch({ schoolId: p.schoolId, tripId: p.tripId, event: 'trip_cancelled', at: p.at });
}

export async function onTripNotStarted(p: TripNotStartedPayload): Promise<void> {
  if (!p.direction) return;
  await enqueueDispatch({ schoolId: p.schoolId, tripId: p.tripId, event: 'trip_not_started', at: new Date().toISOString() });
}

export async function onLeftSchool(p: TrackingStopEvent): Promise<void> {
  if (!p.direction) return;
  await enqueueDispatch({ schoolId: p.schoolId, tripId: p.tripId, event: 'bus_left_school', at: p.at });
}

export async function onStopArrived(p: TrackingStopEvent & { stopId: string }): Promise<void> {
  if (!p.direction) return;
  await enqueueDispatch({ schoolId: p.schoolId, tripId: p.tripId, event: 'arrived_at_stop', stopIds: [p.stopId], at: p.at });
}

/** Keeps the candidate stops not yet queued for (trip, event) — atomic across processes. */
async function newCandidates(store: KvStore, schoolId: string, tripId: string, event: ParentTripEvent, byStop: Record<string, number>): Promise<Record<string, number>> {
  const fresh: Record<string, number> = {};
  for (const [stopId, minutes] of Object.entries(byStop)) {
    if (await store.setIfAbsent(kvKey('notif', schoolId, tripId, event, stopId), '1', ETA_MARKER_TTL_S)) fresh[stopId] = minutes;
  }
  return fresh;
}

export async function onEtaUpdated(p: { schoolId: string; tripId: string; direction: string | null; eta: TripEta }, { store = defaultKv, nowMs = Date.now() }: { store?: KvStore; nowMs?: number } = {}): Promise<void> {
  if (!p.direction || !p.eta || p.eta.quality === 'unavailable' || !p.eta.stops.length) return;
  const found = etaCandidates(p.eta, await etaThresholds(p.schoolId, nowMs));
  for (const [event, byStop] of [['approaching_stop', found.approaching], ['trip_delayed', found.delayed]] as const) {
    if (!Object.keys(byStop).length) continue;
    const fresh = await newCandidates(store, p.schoolId, p.tripId, event, byStop);
    if (!Object.keys(fresh).length) continue;
    await enqueueDispatch({ schoolId: p.schoolId, tripId: p.tripId, event, stopIds: Object.keys(fresh), minutesByStop: fresh, at: p.eta.computedAt });
  }
}

/**
 * Queues an announcement job now. A scheduled announcement (publishedAt in the future) is NOT held
 * in a long-delayed job: the per-minute 'announcement-sweep' delivers it once due (≤ 1 min late),
 * which also survives restarts of the in-process backend (its timers live in memory only).
 */
async function announcementJob(schoolId: string, announcementId: string, action: AnnouncementAction, publishedAt: string | null, nowMs = Date.now()): Promise<void> {
  if (action === 'deliver' && publishedAt && Date.parse(publishedAt) > nowMs + ANNOUNCEMENT_DUE_SKEW_MS) return;
  const suffix = action === 'deliver' && publishedAt ? `-${Date.parse(publishedAt)}` : `-${nowMs}`;
  const payload: AnnouncementJobPayload = { schoolId, announcementId, action };
  try {
    await enqueue(ANNOUNCEMENT_JOB, payload, { jobId: `announcement-${action}-${announcementId}${suffix}` });
  } catch (err) {
    log.error({ err, schoolId, announcementId, action }, 'Could not queue an announcement job');
  }
}

export async function onAnnouncementPublished(p: AnnouncementEventPayload): Promise<void> {
  await announcementJob(p.schoolId, p.announcementId, 'deliver', p.publishedAt);
}

export async function onAnnouncementChanged(p: AnnouncementEventPayload & { change: 'updated' | 'deleted'; changedFields: string[] }): Promise<void> {
  if (p.change === 'deleted') return announcementJob(p.schoolId, p.announcementId, 'withdraw', null);
  // A publish time moved to now delivers at once; a future one is left to the sweep (the deliver job
  // skips anything already sent, withdrawn or not due).
  if (p.changedFields.some((f) => f === 'title' || f === 'body' || f === 'audience')) await announcementJob(p.schoolId, p.announcementId, 'refresh', null);
  if (p.changedFields.includes('publishedAt')) await announcementJob(p.schoolId, p.announcementId, 'deliver', p.publishedAt);
  // A widened audience (drivers → all, parents → all) delivers the segment that has not been delivered yet
  // (the deliver job skips segments already sent; a not-yet-due announcement is left to the sweep).
  else if (p.changedFields.includes('audience')) await announcementJob(p.schoolId, p.announcementId, 'deliver', null);
}

let registered = false;
/** Subscribes the listeners once per process (idempotent). */
export function registerNotificationListeners(): void {
  if (registered) return;
  registered = true;
  events.on('trip.status_changed', onTripStatusChanged);
  events.on('trip.status_changed', onTripCancelled);
  events.on('trip.not_started', onTripNotStarted);
  events.on('trip.interrupted', onTripInterrupted);
  events.on('tracking.left_school', onLeftSchool);
  events.on('tracking.stop_arrived', onStopArrived);
  events.on('tracking.eta_updated', (p) => onEtaUpdated(p));
  events.on('announcement.published', onAnnouncementPublished);
  events.on('announcement.changed', onAnnouncementChanged);
  events.on('school.settings_changed', ({ schoolId }) => clearThresholdCache(schoolId));
}

registerNotificationListeners();
