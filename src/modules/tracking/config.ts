// Tracking configuration of one school (BP §9.1, §9.5, §11.1): effective location intervals and
// thresholds (school overrides resolved against platform defaults) plus the feature-flagged checks.
// Read on every ingest and by the jobs, so it is cached in kv for a short time per school (keys
// carry school_id; settings changes made in another process are picked up within the TTL, and
// 'school.settings_changed' drops this process's copy at once).
import type { SchoolSettingsDto } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { events } from '../../shared/events.js';
import { cached, kv, kvKey } from '../../shared/kv.js';
import { loadSchoolSettings } from '../school/index.js';

export interface TrackingConfig {
  /** Moving interval (s) — never below the 10-s floor. */
  movingIntervalS: number;
  /** Stopped interval (s). */
  stoppedIntervalS: number;
  movingSpeedKmh: number;
  stoppedAfterS: number;
  /** Speed limit for the speeding check (null = not configured). */
  speedLimitKmh: number | null;
  speedingEnabled: boolean;
  routeDeviationEnabled: boolean;
  routeDeviationM: number;
  /** Long unscheduled stop threshold (minutes). */
  stopDurationAlertMin: number;
  tripDelayThresholdMin: number;
  tripNotStartedGraceMin: number;
  approachingStopMinutes: number;
  /** ETA v2 (Google traffic-aware estimate every few minutes) is in force: school + platform + plan `etaV2`. */
  etaV2Enabled: boolean;
}

/** Hard floor of the moving interval (FRD: never faster than 10 s). */
export const MIN_INTERVAL_S = 10;
export const CONFIG_CACHE_TTL_S = 30;

export const configKey = (schoolId: string): string => kvKey('tracking-config', schoolId);

/** Reads the configuration from the school settings inside `tx` (no cache). */
export async function readTrackingConfig(tx: Tx): Promise<TrackingConfig> {
  return toTrackingConfig(await loadSchoolSettings(tx));
}

/** Derives the tracking configuration from a school settings DTO (pure). */
export function toTrackingConfig(s: SchoolSettingsDto): TrackingConfig {
  const e = s.effective;
  return {
    movingIntervalS: Math.max(MIN_INTERVAL_S, e.movingIntervalS),
    stoppedIntervalS: Math.max(e.movingIntervalS, e.stoppedIntervalS),
    movingSpeedKmh: e.movingSpeedKmh,
    stoppedAfterS: e.stoppedAfterS,
    speedLimitKmh: s.speedLimitKmh,
    speedingEnabled: s.enableSpeedingAlert && e.features.speeding && s.speedLimitKmh !== null,
    routeDeviationEnabled: s.enableRouteDeviationAlert && e.features.routeDeviation,
    routeDeviationM: s.routeDeviationM,
    stopDurationAlertMin: s.stopDurationAlertMin,
    tripDelayThresholdMin: s.tripDelayThresholdMin,
    tripNotStartedGraceMin: s.tripNotStartedGraceMin,
    approachingStopMinutes: s.approachingStopMinutes,
    etaV2Enabled: e.features.etaV2,
  };
}

/** Cached configuration of the transaction's school. */
export function trackingConfig(tx: Tx): Promise<TrackingConfig> {
  const schoolId = tx.ctx.schoolId;
  if (!schoolId) throw new TypeError('trackingConfig requires a school context');
  return cached(configKey(schoolId), CONFIG_CACHE_TTL_S, () => readTrackingConfig(tx));
}

/** Expected interval between points for the current motion state. */
export function expectedIntervalS(cfg: Pick<TrackingConfig, 'movingIntervalS' | 'stoppedIntervalS'>, motion: 'moving' | 'stopped'): number {
  return motion === 'stopped' ? cfg.stoppedIntervalS : cfg.movingIntervalS;
}

/** A position older than this is "Location unavailable" (BP §9.3: 3× the expected interval). */
export function staleAfterS(cfg: Pick<TrackingConfig, 'movingIntervalS' | 'stoppedIntervalS'>, motion: 'moving' | 'stopped'): number {
  return Math.max(30, 3 * expectedIntervalS(cfg, motion));
}

/** The gap detector raises its GPS alert once the gap reaches this (never sooner than 5 minutes). */
export function gapAlertAfterS(cfg: Pick<TrackingConfig, 'movingIntervalS' | 'stoppedIntervalS'>, motion: 'moving' | 'stopped'): number {
  return Math.max(300, staleAfterS(cfg, motion));
}

events.on('school.settings_changed', async ({ schoolId }) => {
  await kv.del(configKey(schoolId));
});
