import { describe, expect, it } from 'vitest';
import { REPORT_MAX_RANGE_DAYS, reportQuery } from './reports.js';
import { fuelLogListQuery, fuelUnitOf } from './fuel.js';
import { createMaintenanceLogBody, updateMaintenanceLogBody } from './maintenance.js';
import { alertActionBody, alertListQuery } from './alerts.js';

const BUS = '22222222-2222-4222-8222-222222222222';

describe('reportQuery', () => {
  it('accepts a range of up to REPORT_MAX_RANGE_DAYS days (inclusive)', () => {
    expect(REPORT_MAX_RANGE_DAYS).toBe(366);
    expect(reportQuery.safeParse({ from: '2026-01-01', to: '2027-01-01' }).success).toBe(true);
  });
  it('rejects a longer range on to and a reversed range on from', () => {
    const long = reportQuery.safeParse({ from: '2026-01-01', to: '2027-01-02' });
    expect(long.success).toBe(false);
    if (!long.success) expect(long.error.issues[0]?.path).toEqual(['to']);
    const reversed = reportQuery.safeParse({ from: '2026-10-19', to: '2026-10-18' });
    expect(reversed.success).toBe(false);
    if (!reversed.success) expect(reversed.error.issues[0]?.path).toEqual(['from']);
  });
  it('expands period and treats blanks as absent', () => {
    expect(reportQuery.parse({ period: '2026-10-01..2026-10-31', busId: '', format: 'pdf' })).toEqual({ from: '2026-10-01', to: '2026-10-31', format: 'pdf' });
  });
});

describe('fuel', () => {
  it('fuelUnitOf maps CNG to kg, electric to kWh and everything else to litres', () => {
    expect(fuelUnitOf('cng')).toBe('kg');
    expect(fuelUnitOf('electric')).toBe('kWh');
    for (const f of ['diesel', 'petrol', 'hybrid', 'other', null, undefined]) expect(fuelUnitOf(f)).toBe('L');
  });
  it('fuel log list accepts csv but not pdf, and checks the date order', () => {
    expect(fuelLogListQuery.parse({ format: 'csv', busId: BUS, flagged: 'true' })).toMatchObject({ format: 'csv', busId: BUS, flagged: true });
    expect(fuelLogListQuery.safeParse({ format: 'pdf' }).success).toBe(false);
    expect(fuelLogListQuery.safeParse({ period: '2026-10-31..2026-10-01' }).success).toBe(false);
  });
});

describe('maintenance logs', () => {
  const log = { busId: BUS, serviceType: 'Oil change', serviceDate: '2026-10-19' };
  it('next due date must be after the service date', () => {
    expect(createMaintenanceLogBody.safeParse({ ...log, nextDueDate: '2026-10-19' }).success).toBe(false);
    expect(createMaintenanceLogBody.safeParse({ ...log, nextDueDate: '2027-04-19' }).success).toBe(true);
  });
  it('next due km must be above the odometer reading', () => {
    expect(createMaintenanceLogBody.safeParse({ ...log, odometer: 10000, nextDueKm: 10000 }).success).toBe(false);
    expect(createMaintenanceLogBody.safeParse({ ...log, odometer: 10000, nextDueKm: 15000 }).success).toBe(true);
    expect(createMaintenanceLogBody.safeParse({ ...log, nextDueKm: 15000 }).success).toBe(true);
  });
  it('update needs at least one field', () => {
    expect(updateMaintenanceLogBody.safeParse({}).success).toBe(false);
    expect(updateMaintenanceLogBody.safeParse({ vendor: 'Garage' }).success).toBe(true);
  });
});

describe('alerts', () => {
  it('list query rejects pdf and a reversed range, and splits enum lists', () => {
    expect(alertListQuery.parse({ severity: 'warning,critical' }).severity).toEqual(['warning', 'critical']);
    expect(alertListQuery.safeParse({ format: 'pdf' }).success).toBe(false);
    expect(alertListQuery.safeParse({ from: '2026-10-19', to: '2026-10-01' }).success).toBe(false);
  });
  it('review needs a note; close does not', () => {
    expect(alertActionBody.safeParse({ action: 'review' }).success).toBe(false);
    expect(alertActionBody.safeParse({ action: 'review', note: 'Checked with the driver' }).success).toBe(true);
    expect(alertActionBody.safeParse({ action: 'close' }).success).toBe(true);
  });
});
