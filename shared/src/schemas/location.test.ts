import { describe, expect, it } from 'vitest';
import { CLOCK_DRIFT_MAX_CORRECTION_MS, CLOCK_DRIFT_TOLERANCE_MS, MAX_POINTS_PER_BATCH, locationBatch, locationPoint } from './location.js';
import { deviceInfo } from './device.js';

const point = { t: '2026-10-19T07:45:00.000+05:30', lat: 12.9716, lng: 77.5946 };

describe('locationPoint', () => {
  it('accepts the minimal compact point and the optional telemetry keys', () => {
    expect(locationPoint.parse(point)).toEqual(point);
    const full = { ...point, spd: 32.5, hdg: 360, acc: 8, bat: 100, net: '4g', mv: true };
    expect(locationPoint.parse(full)).toEqual(full);
    expect(locationPoint.parse({ ...point, spd: null, hdg: null, acc: null, bat: null, net: null, mv: null }).spd).toBeNull();
  });

  it.each([
    ['timestamp without offset', { t: '2026-10-19T07:45:00' }],
    ['latitude out of range', { lat: 91 }],
    ['longitude out of range', { lng: -181 }],
    ['negative speed', { spd: -1 }],
    ['speed above 300 km/h', { spd: 301 }],
    ['heading above 360', { hdg: 361 }],
    ['fractional battery', { bat: 50.5 }],
    ['battery above 100', { bat: 101 }],
    ['network label too long', { net: 'x'.repeat(17) }],
  ])('rejects %s', (_label, patch) => {
    expect(locationPoint.safeParse({ ...point, ...patch }).success).toBe(false);
  });
});

describe('locationBatch', () => {
  it('accepts 1 to MAX_POINTS_PER_BATCH points', () => {
    expect(locationBatch.parse({ points: [point] }).points).toHaveLength(1);
    expect(locationBatch.parse({ deviceId: ' dev-1 ', points: Array(MAX_POINTS_PER_BATCH).fill(point) }).deviceId).toBe('dev-1');
  });

  it('rejects an empty or oversized batch', () => {
    expect(locationBatch.safeParse({ points: [] }).success).toBe(false);
    expect(locationBatch.safeParse({ points: Array(MAX_POINTS_PER_BATCH + 1).fill(point) }).success).toBe(false);
  });

  it('keeps the clock-drift limits shared with the driver app', () => {
    expect(MAX_POINTS_PER_BATCH).toBe(500);
    expect(CLOCK_DRIFT_TOLERANCE_MS).toBe(60_000);
    expect(CLOCK_DRIFT_MAX_CORRECTION_MS).toBe(86_400_000);
  });
});

describe('deviceInfo', () => {
  it('accepts a device descriptor', () => {
    expect(deviceInfo.parse({ deviceId: 'android-123456', platform: 'android', appVersion: '1.4.0' })).toEqual({ deviceId: 'android-123456', platform: 'android', appVersion: '1.4.0' });
  });
  it('rejects a short device id, an unknown platform and a non-semver version', () => {
    expect(deviceInfo.safeParse({ deviceId: 'short', platform: 'android' }).success).toBe(false);
    expect(deviceInfo.safeParse({ deviceId: 'android-123456', platform: 'symbian' }).success).toBe(false);
    expect(deviceInfo.safeParse({ deviceId: 'android-123456', platform: 'ios', appVersion: '1.4' }).success).toBe(false);
  });
});
