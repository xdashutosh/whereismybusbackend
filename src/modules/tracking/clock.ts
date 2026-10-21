// Device clock vs server clock (BP §14.3 anti-tamper: "device-time vs server-time drift check"). Pure.
//
// The server judges every location point by its recorded_at (the 10-s floor, backfill, the trip window)
// and every device event by its occurredAt. A phone whose clock is minutes off would otherwise lose its
// points as "outside the trip" or show a stale bus. resolveClockOffset() estimates the offset
// (server − device, ms) of one batch, in this order:
//   sent_at   the batch carries `sentAt` (the app's clock when it sent the batch, same clock as the
//             points) → nowMs − sentAt. Exact up to the upload latency.
//   (clock right) the newest point is fresh on the server clock (within the tolerance behind, or the
//             future tolerance ahead) → no correction; a stored offset is dropped (the driver fixed the
//             clock mid-trip).
//   stored    an offset found earlier for this trip (live state) still fits: the corrected newest point
//             is not ahead of the server clock by more than the tolerance.
//   inferred  (running trips only) no point of the batch is plausible as sent — every point predates the
//             trip window, or every point lies in the future beyond FUTURE_TOLERANCE_MS — which no correct
//             clock can produce: the newest point is taken as "just recorded" → nowMs − newest. Late
//             backfill of an ended trip is legitimately old, so nothing is inferred for it.
// Then (clockAction): |offset| ≤ CLOCK_DRIFT_TOLERANCE_MS → 'none' (timestamps untouched: latency, NTP
// jitter); up to CLOCK_DRIFT_MAX_CORRECTION_MS → 'corrected' (every timestamp shifted by the offset);
// beyond → 'rejected' (the device timestamps are unusable: points are dropped, device events take the
// server receipt time).
import { CLOCK_DRIFT_MAX_CORRECTION_MS, CLOCK_DRIFT_TOLERANCE_MS, type ClockDriftAction } from '@wimb/shared';

export { CLOCK_DRIFT_MAX_CORRECTION_MS, CLOCK_DRIFT_TOLERANCE_MS };

/** Device clocks may run slightly ahead; later points are refused (motion.ts uses the same value). */
export const FUTURE_TOLERANCE_MS = 2 * 60_000;
/** Points / events may predate the recorded trip start by this much (clock skew, start latency). */
export const TRIP_START_TOLERANCE_MS = 10 * 60_000;

export type ClockOffsetSource = 'sent_at' | 'stored' | 'inferred';

export interface ClockInput {
  nowMs: number;
  /** Batch `sentAt` (device clock), when sent. */
  sentAtMs?: number | null;
  /** Offset already applied to this trip (live state), when known. */
  storedOffsetMs?: number | null;
}

export interface ClockResolution {
  /** server − device (ms) estimated for the batch; null when nothing is known. */
  offsetMs: number | null;
  source: ClockOffsetSource | null;
  action: ClockDriftAction;
}

const NONE: ClockResolution = { offsetMs: null, source: null, action: 'none' };

/** What to do with an estimated offset (see the header). */
export function clockAction(offsetMs: number | null): ClockDriftAction {
  if (offsetMs === null || !Number.isFinite(offsetMs)) return 'none';
  const abs = Math.abs(offsetMs);
  if (abs <= CLOCK_DRIFT_TOLERANCE_MS) return 'none';
  return abs <= CLOCK_DRIFT_MAX_CORRECTION_MS ? 'corrected' : 'rejected';
}

function resolution(offsetMs: number, source: ClockOffsetSource): ClockResolution {
  const action = clockAction(offsetMs);
  return { offsetMs: action === 'none' ? null : Math.round(offsetMs), source, action };
}

/**
 * Offset of a batch of device timestamps (ms since epoch, any order). `windowStartMs`: the earliest
 * plausible timestamp (trip start minus tolerance) — only used for the inference.
 */
export function resolveClockOffset(timestampsMs: readonly number[], input: ClockInput & { windowStartMs: number; infer?: boolean }): ClockResolution {
  const { nowMs } = input;
  if (input.sentAtMs !== undefined && input.sentAtMs !== null && Number.isFinite(input.sentAtMs)) {
    return resolution(nowMs - input.sentAtMs, 'sent_at');
  }
  const finite = timestampsMs.filter(Number.isFinite);
  if (!finite.length) return NONE;
  const newest = Math.max(...finite);
  const oldest = Math.min(...finite);
  if (newest >= nowMs - CLOCK_DRIFT_TOLERANCE_MS && newest <= nowMs + FUTURE_TOLERANCE_MS) return NONE;
  const stored = input.storedOffsetMs ?? null;
  if (stored !== null && clockAction(stored) === 'corrected' && newest + stored <= nowMs + CLOCK_DRIFT_TOLERANCE_MS) {
    return { offsetMs: stored, source: 'stored', action: 'corrected' };
  }
  const allBeforeWindow = newest < input.windowStartMs;
  const allInFuture = oldest > nowMs + FUTURE_TOLERANCE_MS;
  if (input.infer !== false && (allBeforeWindow || allInFuture)) return resolution(nowMs - newest, 'inferred');
  return NONE;
}

/** Shifts a device timestamp by the resolved offset (unchanged unless the action is 'corrected'). */
export function correctedMs(deviceMs: number, r: ClockResolution): number {
  return r.action === 'corrected' && r.offsetMs !== null ? deviceMs + r.offsetMs : deviceMs;
}
