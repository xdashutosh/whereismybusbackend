import { describe, expect, it } from 'vitest';
import { PLATFORM_SETTING_KEY_LIST, PLATFORM_SETTING_SCHEMAS, subscriptionBody } from './platform.js';
import { CONSENT_VERSION_RE, consentVersion, httpsUrl } from './privacy.js';
import { notificationPreferencesBody, parentNotificationsQuery } from './parent.js';

describe('platform settings', () => {
  it('lists every setting key', () => {
    expect(PLATFORM_SETTING_KEY_LIST).toEqual(Object.keys(PLATFORM_SETTING_SCHEMAS));
  });
  it('keeps the BP §9.1 stopped interval window of 60–120 s', () => {
    const s = PLATFORM_SETTING_SCHEMAS['location.stopped_interval_s'];
    expect(s.safeParse(59).success).toBe(false);
    expect(s.safeParse(90).success).toBe(true);
    expect(s.safeParse(121).success).toBe(false);
  });
  it('sorts reminder days descending and rejects duplicates', () => {
    const s = PLATFORM_SETTING_SCHEMAS['docs.expiry_reminder_days'];
    expect(s.parse([7, 30, 1])).toEqual([30, 7, 1]);
    expect(s.safeParse([7, 7]).success).toBe(false);
  });
  it('min_supported_version is strict and semver-only', () => {
    const s = PLATFORM_SETTING_SCHEMAS.min_supported_version;
    expect(s.parse({ driver_app: '1.2.0' })).toEqual({ driver_app: '1.2.0' });
    expect(s.safeParse({ driver_app: '1.2' }).success).toBe(false);
    expect(s.safeParse({ kiosk_app: '1.0.0' }).success).toBe(false);
  });
});

describe('subscriptionBody', () => {
  it('applies defaults', () => {
    expect(subscriptionBody.parse({ plan: 'Standard' })).toMatchObject({ plan: 'Standard', status: 'active', maxBuses: null, maxStudents: null, validUntil: null, modules: {} });
  });
  it('validUntil must not be before validFrom', () => {
    const r = subscriptionBody.safeParse({ plan: 'Standard', validFrom: '2026-10-19', validUntil: '2026-10-18' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['validUntil']);
  });
});

describe('privacy primitives', () => {
  it('httpsUrl accepts only https URLs', () => {
    expect(httpsUrl().parse(' https://school.example/privacy ')).toBe('https://school.example/privacy');
    expect(httpsUrl().safeParse('http://school.example/privacy').success).toBe(false);
    expect(httpsUrl().safeParse('not a url').success).toBe(false);
  });
  it('consentVersion accepts short version labels', () => {
    for (const v of ['1', '2026-10', 'v2.1']) expect(consentVersion().parse(v)).toBe(v);
    for (const v of ['', '-1', 'a'.repeat(33), 'v 2']) expect(CONSENT_VERSION_RE.test(v), v).toBe(false);
  });
});

describe('parent app schemas', () => {
  it('notification preferences need at least one toggle', () => {
    expect(notificationPreferencesBody.safeParse({}).success).toBe(false);
    expect(notificationPreferencesBody.safeParse({ morning: {} }).success).toBe(false);
    expect(notificationPreferencesBody.parse({ afternoon: { tripStarted: false } })).toEqual({ afternoon: { tripStarted: false } });
  });
  it('notifications query coerces paging and the unread flag', () => {
    expect(parentNotificationsQuery.parse({ page: '2', limit: '', unread: '1' })).toEqual({ page: 2, unread: true });
    expect(parentNotificationsQuery.safeParse({ unread: 'maybe' }).success).toBe(false);
    expect(parentNotificationsQuery.safeParse({ limit: '101' }).success).toBe(false);
  });
});
