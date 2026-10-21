import { describe, expect, it } from 'vitest';
import { MAX_ODOMETER_KM, endTripBody, odometerReading, reassignTripBody, startTripBody } from './trips.js';

const ID = '11111111-1111-4111-8111-111111111111';
const BUS = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const base = { clientStartId: ID, busId: BUS, odometerReading: 1200.04, odometerFileId: FILE, latitude: 12.97, longitude: 77.59, deviceTime: '2026-10-19T07:30:00Z' };

describe('odometerReading()', () => {
  it('rounds to one decimal', () => {
    expect(odometerReading().parse(1234.56)).toBe(1234.6);
    expect(odometerReading().parse(0)).toBe(0);
  });
  it('rejects negative, too large and non-numeric readings', () => {
    expect(odometerReading().safeParse(-0.1).success).toBe(false);
    expect(odometerReading().safeParse(MAX_ODOMETER_KM + 1).success).toBe(false);
    expect(odometerReading().safeParse('1200').success).toBe(false);
  });
});

describe('startTripBody', () => {
  it('infers a school trip from tripId', () => {
    const parsed = startTripBody.parse({ ...base, tripId: FILE });
    expect(parsed.tripType).toBe('school');
    expect(parsed.odometerReading).toBe(1200);
  });
  it('infers a non-school trip without tripId and then requires a purpose', () => {
    expect(startTripBody.parse({ ...base, purpose: 'Excursion to the museum' }).tripType).toBe('non_school');
    const r = startTripBody.safeParse(base);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join('.'))).toEqual(['purpose']);
  });
  it('rejects an explicit school trip without tripId', () => {
    const r = startTripBody.safeParse({ ...base, tripType: 'school' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['tripId']);
  });
  it('rejects a non-school trip that names a scheduled trip', () => {
    const r = startTripBody.safeParse({ ...base, tripType: 'non_school', tripId: FILE, purpose: 'Excursion' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['tripId']);
  });
  it('treats a blank tripId and purpose as absent', () => {
    const r = startTripBody.safeParse({ ...base, tripId: '', purpose: '' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['purpose']);
  });
});

describe('endTripBody', () => {
  it('accepts an end with pending points and rejects a negative count', () => {
    const { clientStartId: _c, busId: _b, ...end } = base;
    expect(endTripBody.parse({ ...end, pendingPoints: 3 }).pendingPoints).toBe(3);
    expect(endTripBody.safeParse({ ...end, pendingPoints: -1 }).success).toBe(false);
  });
});

describe('reassignTripBody', () => {
  it('needs a driver or conductor change and a reason of at least 3 characters', () => {
    expect(reassignTripBody.safeParse({ reason: 'Driver sick' }).success).toBe(false);
    expect(reassignTripBody.safeParse({ driverId: ID, reason: 'no' }).success).toBe(false);
    expect(reassignTripBody.parse({ driverId: null, reason: 'Driver sick' })).toEqual({ driverId: null, reason: 'Driver sick' });
  });
});
