import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARENT_VISIBILITY,
  MAX_HOLIDAY_DAYS,
  PARENT_VISIBILITY_DEPENDENCIES,
  PARENT_VISIBILITY_FIELDS,
  PARENT_VISIBILITY_SECTIONS,
  alertRecipient,
  createAnnouncementBody,
  createHolidayBody,
  holidayRangeIssues,
  mergeParentVisibility,
  parentVisibilityIssues,
  schoolSettingsIssues,
} from './school.js';

describe('parent visibility matrix', () => {
  it('the default matrix has exactly the declared fields and passes its own rules', () => {
    for (const s of PARENT_VISIBILITY_SECTIONS) expect(Object.keys(DEFAULT_PARENT_VISIBILITY[s]).sort()).toEqual([...PARENT_VISIBILITY_FIELDS[s]].sort());
    expect(parentVisibilityIssues(DEFAULT_PARENT_VISIBILITY)).toEqual([]);
  });

  it('dependencies point at fields of the same section', () => {
    for (const s of PARENT_VISIBILITY_SECTIONS) {
      const fields: readonly string[] = PARENT_VISIBILITY_FIELDS[s];
      for (const [file, status] of Object.entries(PARENT_VISIBILITY_DEPENDENCIES[s])) {
        expect(fields).toContain(file);
        expect(fields).toContain(status);
      }
    }
  });

  it('merge applies boolean overrides, drops unknown keys and non-booleans, keeps the rest', () => {
    const merged = mergeParentVisibility(DEFAULT_PARENT_VISIBILITY, {
      bus: { capacity: true, plate: 'no', bogus: true },
      driver: { phone: true },
      extra: { x: true },
    });
    expect(merged.bus.capacity).toBe(true);
    expect(merged.bus.plate).toBe(DEFAULT_PARENT_VISIBILITY.bus.plate);
    expect(merged.bus).not.toHaveProperty('bogus');
    expect(merged.driver.phone).toBe(true);
    expect(merged).not.toHaveProperty('extra');
    expect(merged.conductor).toEqual(DEFAULT_PARENT_VISIBILITY.conductor);
  });

  it('merge tolerates a missing patch', () => {
    expect(mergeParentVisibility(DEFAULT_PARENT_VISIBILITY, null)).toEqual(DEFAULT_PARENT_VISIBILITY);
  });

  it('a visible file requires its visible status', () => {
    const m = mergeParentVisibility(DEFAULT_PARENT_VISIBILITY, { bus: { insuranceFile: true, insuranceStatus: false }, driver: { licenceFile: true, licenceValidity: false } });
    expect(parentVisibilityIssues(m).map((i) => i.path)).toEqual(['bus.insuranceFile', 'driver.licenceFile']);
  });
});

describe('schoolSettingsIssues()', () => {
  const ok = { movingIntervalS: 15, stoppedIntervalS: 90, enableSpeedingAlert: true, speedLimitKmh: 50 };
  it('accepts consistent settings', () => {
    expect(schoolSettingsIssues(ok)).toEqual([]);
    expect(schoolSettingsIssues({ ...ok, locationRetentionMonths: 6, platformRetentionMonths: 6 })).toEqual([]);
  });
  it('reports each broken rule on its field', () => {
    const issues = schoolSettingsIssues({ movingIntervalS: 120, stoppedIntervalS: 90, enableSpeedingAlert: true, speedLimitKmh: null, locationRetentionMonths: 13, platformRetentionMonths: 12 });
    expect(issues.map((i) => i.path)).toEqual(['locationRetentionMonths', 'locationStoppedIntervalS', 'speedLimitKmh']);
  });
  it('ignores the retention rule without a platform maximum or an override', () => {
    expect(schoolSettingsIssues({ ...ok, locationRetentionMonths: 99 })).toEqual([]);
    expect(schoolSettingsIssues({ ...ok, locationRetentionMonths: null, platformRetentionMonths: 1 })).toEqual([]);
  });
});

describe('holidays', () => {
  it('holidayRangeIssues checks order and length (inclusive)', () => {
    expect(holidayRangeIssues('2026-10-19', '2026-10-19')).toEqual([]);
    expect(holidayRangeIssues('2026-10-19', '2026-10-18')[0]?.path).toBe('endDate');
    expect(holidayRangeIssues('2026-01-01', '2026-12-31')).toEqual([]);
    expect(MAX_HOLIDAY_DAYS).toBe(366);
    expect(holidayRangeIssues('2026-01-01', '2027-01-01')).toEqual([]);
    expect(holidayRangeIssues('2026-01-01', '2027-01-02')[0]?.message).toMatch(/at most 366 days/);
  });
  it('createHolidayBody defaults appliesTo and checks the range', () => {
    expect(createHolidayBody.parse({ name: 'Diwali', startDate: '2026-11-08' })).toEqual({ name: 'Diwali', startDate: '2026-11-08', appliesTo: 'all' });
    const r = createHolidayBody.safeParse({ name: 'Diwali', startDate: '2026-11-08', endDate: '2026-11-07' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['endDate']);
  });
});

describe('createAnnouncementBody', () => {
  it('applies defaults', () => {
    expect(createAnnouncementBody.parse({ title: 'Rain', body: 'Buses run late' })).toEqual({ title: 'Rain', body: 'Buses run late', audience: 'all', isPinned: false });
  });
  it('requires expiresAt after publishedAt', () => {
    const r = createAnnouncementBody.safeParse({ title: 'T', body: 'B', publishedAt: '2026-10-19T10:00:00Z', expiresAt: '2026-10-19T15:30:00+05:30' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['expiresAt']);
    expect(createAnnouncementBody.safeParse({ title: 'T', body: 'B', publishedAt: '2026-10-19T10:00:00Z', expiresAt: '2026-10-19T10:00:01Z' }).success).toBe(true);
  });
});

describe('alertRecipient', () => {
  it('needs a school admin, an e-mail or a phone', () => {
    expect(alertRecipient.safeParse({ name: 'Ops' }).success).toBe(false);
    expect(alertRecipient.parse({ email: 'Ops@School.example' })).toEqual({ email: 'ops@school.example', minSeverity: 'warning' });
  });
  it('accepts only E.164 phone numbers', () => {
    expect(alertRecipient.safeParse({ phone: '+919845012345' }).success).toBe(true);
    expect(alertRecipient.safeParse({ phone: '09845012345' }).success).toBe(false);
  });
});
