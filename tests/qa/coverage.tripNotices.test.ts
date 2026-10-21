// BP §10.4 / §11.2 (coverage finding, moved from tests-pre/coverage): parents are told about a
// broken-down (interrupted) or cancelled trip. Every process that loads the modules and the jobs has a
// listener for 'trip.interrupted' and a cancellation listener on 'trip.status_changed', each queues
// the regular parent dispatch (trip_interrupted / trip_cancelled), and both events have templates
// (first name + bus code only) and preference toggles. The end-to-end delivery (inbox rows, dedupe,
// opt-outs) is covered by tests/notifications.notices.test.ts.
import { NOTIFICATION_TOGGLE_OF, PARENT_TRIP_EVENTS } from '@wimb/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderTripMessage } from '../../src/modules/notifications/templates.js';
import { events } from '../../src/shared/events.js';

const IDS = { schoolId: '00000000-0000-4000-8000-000000000001', tripId: '00000000-0000-4000-8000-000000000002' };
const status = (o: Record<string, unknown>) => ({ ...IDS, busId: 'b', tripType: 'school', direction: 'morning', at: new Date().toISOString(), ...o });

afterEach(() => vi.restoreAllMocks());

describe('trip disruption notices', () => {
  it('registers listeners for trip.interrupted and cancellations once modules and jobs load', async () => {
    await import('../../src/modules/index.js');
    await import('../../src/jobs/index.js');
    expect(events.listenerCount('trip.interrupted')).toBeGreaterThan(0);
    expect(events.listenerCount('trip.status_changed')).toBeGreaterThanOrEqual(2);
  });

  it('queues trip_interrupted and trip_cancelled dispatches (not automatic calendar cancellations)', async () => {
    const { jobs } = await import('../../src/jobs/index.js');
    const enqueue = vi.spyOn(jobs, 'enqueue').mockResolvedValue(undefined);
    const queued = () => enqueue.mock.calls.map((c) => (c[1] as { event: string }).event);

    await events.emitAndWait('trip.interrupted', status({ status: 'in_progress', previousStatus: 'in_progress', reason: 'Flat tyre' }) as never);
    expect(queued()).toEqual(['trip_interrupted']);

    await events.emitAndWait('trip.status_changed', status({ status: 'cancelled', previousStatus: 'in_progress', reason: 'Breakdown' }) as never);
    expect(queued()).toEqual(['trip_interrupted', 'trip_cancelled']);

    // Holiday / schedule edits and non-school trips are not service disruptions.
    await events.emitAndWait('trip.status_changed', status({ status: 'cancelled', previousStatus: 'scheduled', reason: 'School holiday: Diwali' }) as never);
    await events.emitAndWait('trip.status_changed', status({ status: 'cancelled', previousStatus: 'in_progress', tripType: 'other', direction: null }) as never);
    await events.emitAndWait('trip.interrupted', status({ status: 'in_progress', tripType: 'other', direction: null }) as never);
    expect(queued()).toEqual(['trip_interrupted', 'trip_cancelled']);
  });

  it('has preference toggles and privacy-safe templates for both events', () => {
    for (const event of ['trip_interrupted', 'trip_cancelled'] as const) {
      expect(PARENT_TRIP_EVENTS).toContain(event);
      expect(NOTIFICATION_TOGGLE_OF[event]).toBeTruthy();
      for (const lang of ['en', 'hi'] as const) {
        const m = renderTripMessage(event, lang, { childFirstName: 'Aarav', busCode: 'R1', direction: 'morning' });
        expect(m.title).toContain('R1');
        expect(m.body).toContain('Aarav');
        expect(m.body).not.toContain('Sharma');
      }
    }
  });
});
