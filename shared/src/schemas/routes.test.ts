import { describe, expect, it } from 'vitest';
import { createTripScheduleBody, daysOfWeek, reorderStopsBody, updateTripScheduleBody } from './routes.js';
import { bulkAssignmentBody, studentAssignmentBody, studentParentLinkBody } from './students.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('daysOfWeek()', () => {
  it('de-duplicates and sorts ISO weekdays', () => {
    expect(daysOfWeek().parse([5, 1, 1, 3])).toEqual([1, 3, 5]);
  });
  it('rejects empty lists and numbers outside 1–7', () => {
    expect(daysOfWeek().safeParse([]).success).toBe(false);
    expect(daysOfWeek().safeParse([0]).success).toBe(false);
    expect(daysOfWeek().safeParse([8]).success).toBe(false);
  });
});

describe('trip schedules', () => {
  const schedule = { busId: A, routeId: B, plannedStartTime: '07:15:00', daysOfWeek: [1, 2, 3, 4, 5] };
  it('normalises the start time and checks the validity window', () => {
    expect(createTripScheduleBody.parse(schedule).plannedStartTime).toBe('07:15');
    expect(createTripScheduleBody.safeParse({ ...schedule, validFrom: '2026-10-19', validTo: '2026-10-18' }).success).toBe(false);
    expect(createTripScheduleBody.parse({ ...schedule, validFrom: '', validTo: '' })).toMatchObject({ validFrom: null, validTo: null });
  });
  it('update needs a field', () => {
    expect(updateTripScheduleBody.safeParse({}).success).toBe(false);
    expect(updateTripScheduleBody.safeParse({ isActive: false }).success).toBe(true);
  });
});

describe('reorderStopsBody', () => {
  it('rejects a stop listed twice', () => {
    expect(reorderStopsBody.safeParse({ stopIds: [A, B, A] }).success).toBe(false);
    expect(reorderStopsBody.parse({ stopIds: [B, A] }).stopIds).toEqual([B, A]);
  });
});

describe('student assignments', () => {
  const target = { busId: A, routeId: B, stopId: C };
  it('need morning and/or afternoon; null ends an assignment', () => {
    expect(studentAssignmentBody.safeParse({ effectiveFrom: '2026-10-19' }).success).toBe(false);
    expect(studentAssignmentBody.parse({ morning: target, afternoon: null })).toEqual({ morning: target, afternoon: null });
  });
  it('bulk assignment de-duplicates student ids', () => {
    expect(bulkAssignmentBody.parse({ studentIds: [A, A.toUpperCase(), B], morning: target }).studentIds).toEqual([A, B]);
    expect(bulkAssignmentBody.safeParse({ studentIds: [], morning: target }).success).toBe(false);
  });
});

describe('studentParentLinkBody', () => {
  const parent = { phone: '+91 98450 12345', fullName: 'Asha Rao' };
  it('link takes exactly one of parentId or parent', () => {
    expect(studentParentLinkBody.parse({ parentId: A })).toMatchObject({ action: 'link', parentId: A });
    expect(studentParentLinkBody.safeParse({ parent }).success).toBe(true);
    expect(studentParentLinkBody.safeParse({}).success).toBe(false);
    expect(studentParentLinkBody.safeParse({ parentId: A, parent }).success).toBe(false);
  });
  it('unlink requires parentId', () => {
    expect(studentParentLinkBody.safeParse({ action: 'unlink' }).success).toBe(false);
    expect(studentParentLinkBody.safeParse({ action: 'unlink', parentId: A }).success).toBe(true);
  });
});
