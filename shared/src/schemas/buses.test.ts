import { describe, expect, it } from 'vitest';
import { assignStaffBody, busDocumentVisibilityBody, createBusBody, createBusDocumentBody, registrationNo, updateBusBody, updateBusDocumentBody, verifyBusDocumentBody } from './buses.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('registrationNo()', () => {
  it('upper-cases and strips spaces, hyphens and dots', () => {
    expect(registrationNo().parse('ka-01 ab.1234')).toBe('KA01AB1234');
  });
  it('rejects too short, too long and non-alphanumeric plates', () => {
    for (const v of ['KA1', 'K'.repeat(21), 'KA01#1234', 42]) expect(registrationNo().safeParse(v).success, String(v)).toBe(false);
  });
});

describe('createBusBody / updateBusBody', () => {
  it('maps blank optional enums/ints to null and strips unknown keys', () => {
    const parsed = createBusBody.parse({ code: ' B-01 ', registrationNo: 'ka01ab1234', vehicleType: '', capacity: '', fuelType: 'diesel', school_id: A });
    expect(parsed).toMatchObject({ code: 'B-01', registrationNo: 'KA01AB1234', vehicleType: null, capacity: null, fuelType: 'diesel' });
    expect(parsed).not.toHaveProperty('school_id');
  });
  it('enforces numeric ranges', () => {
    expect(createBusBody.safeParse({ code: 'B1', registrationNo: 'KA01AB1234', capacity: 201 }).success).toBe(false);
    expect(createBusBody.safeParse({ code: 'B1', registrationNo: 'KA01AB1234', manufactureYear: 1979 }).success).toBe(false);
    expect(createBusBody.safeParse({ code: 'B1', registrationNo: 'KA01AB1234', lastKnownOdometer: -1 }).success).toBe(false);
  });
  it('update requires at least one field', () => {
    expect(updateBusBody.safeParse({}).success).toBe(false);
    expect(updateBusBody.parse({ status: 'maintenance' })).toEqual({ status: 'maintenance' });
  });
});

describe('assignStaffBody', () => {
  it('requires at least one role', () => {
    const r = assignStaffBody.safeParse({ note: 'x' });
    expect(r.success).toBe(false);
  });
  it('accepts null (unassign) and maps blank to null', () => {
    expect(assignStaffBody.parse({ primaryDriverId: A, conductorId: '' })).toMatchObject({ primaryDriverId: A, conductorId: null });
  });
  it('rejects the same person in two roles on the second role', () => {
    const r = assignStaffBody.safeParse({ primaryDriverId: A, backupDriverId: A.toUpperCase(), conductorId: B });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues).toHaveLength(1);
      expect(r.error.issues[0]?.path).toEqual(['backupDriverId']);
    }
  });
});

describe('bus documents', () => {
  it('rejects an expiry date before the start date on expiryDate', () => {
    const r = createBusDocumentBody.safeParse({ docType: 'insurance', startDate: '2026-10-19', expiryDate: '2026-10-18' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['expiryDate']);
    expect(createBusDocumentBody.safeParse({ docType: 'insurance', startDate: '2026-10-19', expiryDate: '2026-10-19' }).success).toBe(true);
    expect(createBusDocumentBody.parse({ docType: 'insurance', startDate: '', fileId: '' })).toMatchObject({ startDate: null, fileId: null });
  });
  it('update needs a field and keeps the date order', () => {
    expect(updateBusDocumentBody.safeParse({}).success).toBe(false);
    expect(updateBusDocumentBody.safeParse({ startDate: '2026-10-19', expiryDate: '2025-10-19' }).success).toBe(false);
  });
  it('visibility needs one of its two flags', () => {
    expect(busDocumentVisibilityBody.safeParse({}).success).toBe(false);
    expect(busDocumentVisibilityBody.parse({ visibleToParentsFile: true })).toEqual({ visibleToParentsFile: true });
  });
  it('rejecting a document needs a note', () => {
    expect(verifyBusDocumentBody.safeParse({ status: 'rejected' }).success).toBe(false);
    expect(verifyBusDocumentBody.safeParse({ status: 'rejected', note: '  ' }).success).toBe(false);
    expect(verifyBusDocumentBody.safeParse({ status: 'rejected', note: 'Blurred scan' }).success).toBe(true);
    expect(verifyBusDocumentBody.safeParse({ status: 'verified' }).success).toBe(true);
  });
});
