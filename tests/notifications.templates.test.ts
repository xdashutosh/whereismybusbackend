// Pure parts of the notifications engine: lock-screen-safe templates (en + hi), channel selection,
// ETA candidate detection (approaching / delayed), dispatch gating and deterministic job ids.
import { NOTIFICATION_EVENTS, type TripEta } from '@wimb/shared';
import { describe, expect, it } from 'vitest';
import { selectChannels } from '../src/modules/notifications/channels.js';
import { gateReason, MAX_SIGNAL_AGE_MS } from '../src/modules/notifications/dispatch.js';
import { pushData } from '../src/modules/notifications/delivery.js';
import { dispatchJobId, etaCandidates } from '../src/modules/notifications/listeners.js';
import type { DispatchTripRow } from '../src/modules/notifications/repository.js';
import { clip, firstNameOf, languageOf, MAX_PUSH_BODY, MAX_PUSH_TITLE, renderAnnouncement, renderTripMessage } from '../src/modules/notifications/templates.js';

const vars = { childFirstName: 'Aarav Kumar Sharma', busCode: 'R1', direction: 'morning' as const, minutes: 4 };

describe('trip templates', () => {
  it('render every event in English and Hindi with the first name and bus code only', () => {
    for (const lang of ['en', 'hi'] as const) {
      for (const event of NOTIFICATION_EVENTS) {
        const m = renderTripMessage(event, lang, vars);
        expect(m.title.length).toBeGreaterThan(0);
        expect(m.title.length).toBeLessThanOrEqual(MAX_PUSH_TITLE);
        expect(m.body.length).toBeLessThanOrEqual(MAX_PUSH_BODY);
        expect(`${m.title} ${m.body}`).toContain('R1');
        expect(m.body).toContain('Aarav');
        expect(`${m.title} ${m.body}`).not.toMatch(/Kumar|Sharma/);
      }
    }
  });

  it('has exact English texts', () => {
    expect(renderTripMessage('trip_started', 'en', vars)).toEqual({ title: 'Bus R1 has started', body: 'The morning trip of bus R1 for Aarav has started.' });
    expect(renderTripMessage('approaching_stop', 'en', vars).body).toBe("Bus R1 is about 4 minutes away from Aarav's stop.");
    expect(renderTripMessage('approaching_stop', 'en', { ...vars, minutes: 1 }).body).toBe("Bus R1 is about 1 minute away from Aarav's stop.");
    expect(renderTripMessage('arrived_at_stop', 'en', vars).body).toBe("Bus R1 has reached Aarav's stop.");
    expect(renderTripMessage('trip_delayed', 'en', { ...vars, minutes: 12.4 }).body).toBe("Bus R1 is running about 12 minutes late for Aarav's stop.");
    expect(renderTripMessage('trip_not_started', 'en', { ...vars, direction: 'afternoon' }).body).toBe('The afternoon trip of bus R1 for Aarav has not started yet.');
    expect(renderTripMessage('bus_left_school', 'en', vars).body).toBe("Bus R1 (Aarav's morning bus) has left the school.");
  });

  it('has Hindi texts', () => {
    expect(renderTripMessage('trip_started', 'hi', vars)).toEqual({ title: 'बस R1 चल पड़ी है', body: 'Aarav की सुबह की बस R1 की यात्रा शुरू हो गई है।' });
    expect(renderTripMessage('approaching_stop', 'hi', vars).body).toBe('बस R1 Aarav के स्टॉप से लगभग 4 मिनट दूर है।');
    expect(renderTripMessage('trip_not_started', 'hi', { ...vars, direction: 'afternoon' }).body).toContain('दोपहर');
  });

  it('falls back for missing names and clips long bus codes', () => {
    expect(renderTripMessage('arrived_at_stop', 'en', { ...vars, childFirstName: '  ' }).body).toBe("Bus R1 has reached your child's stop.");
    expect(renderTripMessage('arrived_at_stop', 'hi', { ...vars, childFirstName: '' }).body).toContain('आपके बच्चे');
    expect(renderTripMessage('arrived_at_stop', 'en', { ...vars, busCode: 'X'.repeat(50) }).title.length).toBeLessThanOrEqual(MAX_PUSH_TITLE);
  });

  it('helpers', () => {
    expect(firstNameOf('  Diya   Patel ')).toBe('Diya');
    expect(firstNameOf(null)).toBe('');
    expect(clip('a  b\n c', 10)).toBe('a b c');
    expect(clip('abcdefghijkl', 6)).toBe('abcde…');
    expect(languageOf('hi')).toBe('hi');
    expect(languageOf('fr')).toBe('en');
    expect(languageOf(null)).toBe('en');
  });

  it('announcements: generic lock-screen title, school text in the inbox', () => {
    const a = renderAnnouncement('hi', { title: 'PTM on Saturday', body: 'x'.repeat(2500) });
    expect(a.push).toEqual({ title: 'स्कूल से नई सूचना', body: 'PTM on Saturday' });
    expect(a.inbox.title).toBe('PTM on Saturday');
    expect(a.inbox.body.length).toBe(2000);
    expect(renderAnnouncement('en', { title: 'T', body: 'B' }).push.title).toBe('New notice from school');
  });
});

describe('channel selection', () => {
  const base = { pushAdapterEnabled: true, platformPush: true, smsFeature: false, whatsappFeature: false, whatsappAdapterEnabled: false };
  it('push by default, sms/whatsapp only with the school feature', () => {
    expect(selectChannels(base)).toEqual({ push: true, sms: false, whatsapp: false, skipped: { sms: 'FEATURE_DISABLED', whatsapp: 'FEATURE_DISABLED' } });
    expect(selectChannels({ ...base, smsFeature: true }).sms).toBe(true);
  });
  it('explains why push is not used', () => {
    expect(selectChannels({ ...base, pushAdapterEnabled: false }).skipped.push).toBe('PUSH_DISABLED');
    expect(selectChannels({ ...base, platformPush: false }).skipped.push).toBe('MODULE_DISABLED');
  });
  it('whatsapp needs the feature and an adapter', () => {
    expect(selectChannels({ ...base, whatsappFeature: true }).skipped.whatsapp).toBe('NOT_AVAILABLE');
    expect(selectChannels({ ...base, whatsappFeature: true, whatsappAdapterEnabled: true }).whatsapp).toBe(true);
  });
});

function eta(o: Partial<TripEta> & { stops: TripEta['stops'] }): TripEta {
  return { computedAt: '2026-10-19T02:00:00.000Z', quality: 'good', reason: null, speedKmh: 25, destinationEtaAt: null, ...o };
}
const stop = (stopId: string, etaMin: number, delayMin: number | null) => ({
  stopId,
  sequence: 1,
  name: 'Stop',
  remainingM: 500,
  etaAt: new Date(Date.parse('2026-10-19T02:00:00.000Z') + etaMin * 60_000).toISOString(),
  plannedAt: null,
  delayMin,
});

describe('ETA candidates', () => {
  const t = { approachingStopMinutes: 5, delayThresholdMin: 10 };
  it('finds stops within the approaching window and late stops', () => {
    const c = etaCandidates(eta({ stops: [stop('s1', 2.2, 3), stop('s2', 5, 11), stop('s3', 9, 15)] }), t);
    expect(c.approaching).toEqual({ s1: 3, s2: 5 });
    expect(c.delayed).toEqual({ s2: 11, s3: 15 });
  });
  it('degraded ETA still gives approaching but never delayed; unavailable gives nothing', () => {
    const d = etaCandidates(eta({ quality: 'degraded', stops: [stop('s1', 1, 30)] }), t);
    expect(d).toEqual({ approaching: { s1: 1 }, delayed: {} });
    expect(etaCandidates(eta({ quality: 'unavailable', stops: [stop('s1', 1, 30)] }), t)).toEqual({ approaching: {}, delayed: {} });
    expect(etaCandidates(null, t)).toEqual({ approaching: {}, delayed: {} });
  });
  it('a delay exactly at the threshold is not "late"', () => {
    expect(etaCandidates(eta({ stops: [stop('s1', 20, 10)] }), t).delayed).toEqual({});
  });
});

describe('dispatch gating', () => {
  const trip = (o: Partial<DispatchTripRow> = {}): DispatchTripRow => ({ id: 't', status: 'in_progress', trip_type: 'school', direction: 'morning', bus_id: 'b', route_id: 'r', trip_date: '2026-10-19', bus_code: 'R1', ...o });
  const now = Date.parse('2026-10-19T02:00:00.000Z');
  const at = new Date(now - 1000).toISOString();
  it('requires a school trip with a direction', () => {
    expect(gateReason(null, { event: 'trip_started', at }, now)).toBe('TRIP_NOT_FOUND');
    expect(gateReason(trip({ trip_type: 'non_school' }), { event: 'trip_started', at }, now)).toBe('NOT_A_SCHOOL_TRIP');
    expect(gateReason(trip({ direction: null }), { event: 'arrived_at_stop', at }, now)).toBe('NOT_A_SCHOOL_TRIP');
  });
  it('matches the trip status to the event', () => {
    expect(gateReason(trip(), { event: 'trip_started', at }, now)).toBeNull();
    expect(gateReason(trip({ status: 'completed' }), { event: 'trip_started', at }, now)).toBe('TRIP_NOT_RUNNING');
    expect(gateReason(trip({ status: 'completed' }), { event: 'arrived_at_stop', at }, now)).toBeNull();
    expect(gateReason(trip({ status: 'cancelled' }), { event: 'arrived_at_stop', at }, now)).toBe('TRIP_NOT_RUNNING');
    expect(gateReason(trip({ status: 'scheduled' }), { event: 'trip_not_started', at }, now)).toBeNull();
    expect(gateReason(trip({ status: 'missed' }), { event: 'trip_not_started', at }, now)).toBeNull();
    expect(gateReason(trip(), { event: 'trip_not_started', at }, now)).toBe('TRIP_STARTED');
  });
  it('drops stale signals', () => {
    const old = new Date(now - MAX_SIGNAL_AGE_MS.approaching_stop - 1000).toISOString();
    expect(gateReason(trip(), { event: 'approaching_stop', at: old }, now)).toBe('STALE_SIGNAL');
    expect(gateReason(trip(), { event: 'trip_started', at: old }, now)).toBeNull();
  });
});

describe('job ids and push data', () => {
  it('are deterministic, BullMQ-safe and order independent', () => {
    const a = dispatchJobId({ event: 'arrived_at_stop', tripId: 'trip-1', stopIds: ['b', 'a'] });
    expect(a).toBe(dispatchJobId({ event: 'arrived_at_stop', tripId: 'trip-1', stopIds: ['a', 'b'] }));
    expect(a).not.toContain(':');
    expect(dispatchJobId({ event: 'trip_started', tripId: 'trip-1' })).toBe('notif-trip_started-trip-1');
  });
  it('push data keeps non-empty strings only', () => {
    expect(pushData({ type: 'trip_started', screen: 'track', schoolId: 's', studentId: 'st', tripId: undefined })).toEqual({ type: 'trip_started', screen: 'track', schoolId: 's', studentId: 'st' });
  });
});
