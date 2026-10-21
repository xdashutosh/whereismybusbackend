// Pure helpers of the routes module: week-window overlap (schedules), the planned path builder (school
// endpoint per direction, merge radius, fingerprint), editor warnings and end-time formatting.
import { describe, expect, it } from 'vitest';
import { endTimeOf, routeWarnings } from '../src/modules/routes/dto.js';
import { findConflicts, overlappingDays, weekIntervals, WEEK_MIN } from '../src/modules/routes/overlap.js';
import { buildPath } from '../src/modules/routes/path.js';

describe('schedule windows', () => {
  it('maps windows onto the week and splits the Sunday-night wrap', () => {
    expect(weekIntervals({ plannedStartTime: '07:00', durationMin: 40, daysOfWeek: [1, 3] })).toEqual([
      { day: 1, start: 420, end: 460 },
      { day: 3, start: 2 * 1440 + 420, end: 2 * 1440 + 460 },
    ]);
    expect(weekIntervals({ plannedStartTime: '23:30', durationMin: 60, daysOfWeek: [7] })).toEqual([
      { day: 7, start: WEEK_MIN - 30, end: WEEK_MIN },
      { day: 7, start: 0, end: 30 },
    ]);
  });

  it('treats windows as half-open and reports the shared weekdays of the candidate', () => {
    const base = { plannedStartTime: '07:00', durationMin: 40, daysOfWeek: [1, 2, 3, 4, 5] };
    expect(overlappingDays({ plannedStartTime: '07:39', durationMin: 30, daysOfWeek: [2, 6] }, base)).toEqual([2]);
    expect(overlappingDays({ plannedStartTime: '07:40', durationMin: 30, daysOfWeek: [1, 2] }, base)).toEqual([]);
    expect(overlappingDays({ plannedStartTime: '06:30', durationMin: 31, daysOfWeek: [5] }, base)).toEqual([5]);
    expect(overlappingDays({ plannedStartTime: '06:30', durationMin: 30, daysOfWeek: [5] }, base)).toEqual([]);
    expect(overlappingDays({ plannedStartTime: '00:10', durationMin: 15, daysOfWeek: [1] }, { plannedStartTime: '23:50', durationMin: 30, daysOfWeek: [7] })).toEqual([1]);
    expect(overlappingDays({ plannedStartTime: '23:50', durationMin: 30, daysOfWeek: [1] }, { plannedStartTime: '00:10', durationMin: 15, daysOfWeek: [2] })).toEqual([1]);
  });

  it('lists every conflicting schedule with its details', () => {
    const conflicts = findConflicts({ plannedStartTime: '14:10', durationMin: 30, daysOfWeek: [1, 2] }, [
      { id: 'a', name: 'PM', routeCode: 'R1', direction: 'afternoon', plannedStartTime: '14:00:00', durationMin: 30, daysOfWeek: [2, 3], estimatedEndTime: '14:30' },
      { id: 'b', name: null, routeCode: 'R2', direction: 'afternoon', plannedStartTime: '15:00:00', durationMin: 30, daysOfWeek: [1, 2], estimatedEndTime: '15:30' },
    ]);
    expect(conflicts).toEqual([{ scheduleId: 'a', name: 'PM', routeCode: 'R1', direction: 'afternoon', plannedStartTime: '14:00', estimatedEndTime: '14:30', sharedDays: [2] }]);
  });

  it('formats end times across midnight', () => {
    expect(endTimeOf('07:00', 40)).toBe('07:40');
    expect(endTimeOf('23:30', 60)).toBe('00:30+1');
  });
});

describe('planned path builder', () => {
  const stops = [
    { id: 's1', latitude: 12.95, longitude: 77.64 },
    { id: 's2', latitude: 12.96, longitude: 77.62 },
  ];
  const school = { latitude: 12.9716, longitude: 77.5946 };

  it('ends a morning route and starts an afternoon route at the school', () => {
    expect(buildPath('morning', stops, school).points.map((p) => p.stopId)).toEqual(['s1', 's2', null]);
    expect(buildPath('afternoon', stops, school).points.map((p) => p.stopId)).toEqual([null, 's1', 's2']);
    expect(buildPath('morning', stops, null)).toMatchObject({ includesSchool: false });
    expect(buildPath('morning', [], school).points).toEqual([]);
  });

  it('skips the school when the end stop is at the gate and fingerprints the geometry', () => {
    const atGate = [...stops, { id: 'gate', latitude: 12.9717, longitude: 77.5947 }];
    const p = buildPath('morning', atGate, school);
    expect(p.includesSchool).toBe(false);
    expect(p.points).toHaveLength(3);
    expect(buildPath('morning', stops, school).fingerprint).not.toBe(buildPath('morning', [stops[1]!, stops[0]!], school).fingerprint);
    expect(buildPath('morning', stops, school).fingerprint).toBe(buildPath('morning', stops.map((s) => ({ ...s })), school).fingerprint);
  });

  it('derives editor warnings', () => {
    expect(routeWarnings({ polyline_source: null }, [{ expected_time: '07:10:00' }], 2)).toEqual(['too_few_stops', 'polyline_missing']);
    expect(routeWarnings({ polyline_source: 'straight' }, [{ expected_time: '07:10:00' }, { expected_time: null }, { expected_time: '07:05:00' }], 3)).toEqual([
      'expected_times_out_of_order',
      'polyline_straight',
    ]);
    expect(routeWarnings({ polyline_source: 'google' }, [{ expected_time: '07:00:00' }, { expected_time: '07:05:00' }], 3)).toEqual([]);
  });
});
