// Regression: the demo seeds must tell the same story on every weekday. Seed 75 picked the "2 days ago"
// speeding trip by calendar days while seed 70 plans its anomalies by school days (Mon–Sat), so on
// Mondays/Tuesdays no speeding stretch was seeded; seed 78's R1/R5 due dates tied or flipped with the
// weekday (Sunday shift), so the due list order changed from day to day.
import { afterAll, describe, expect, it } from 'vitest';
import { schoolDaysAgoSql } from '../../src/db/seeds/75_tracking.js';
import { addDays, fuelSeries, maintenanceSeries } from '../../src/db/seeds/78_fleet_ops.js';
import { closeDb, ownerQuery } from '../helpers/db.js';

afterAll(closeDb);

// Two full weeks of "today" values (2026-10-12 is a Monday).
const TODAYS = Array.from({ length: 14 }, (_, i) => addDays('2026-10-12', i));
const isSunday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() === 0;

/** Reference: seed 70's pastSchoolDays — the last school days (Mon–Sat) before today, newest first. */
function lastSchoolDays(today: string, n: number): string[] {
  const out: string[] = [];
  for (let d = addDays(today, -1); out.length < n; d = addDays(d, -1)) if (!isSunday(d)) out.push(d);
  return out;
}

describe('seed 75 counts days like seed 70', () => {
  it('maps the n-th last school day to n on every weekday, and today to 0', async () => {
    for (const today of TODAYS) {
      const days = lastSchoolDays(today, 5);
      const rows = (
        await ownerQuery<{ day: string; ago: number }>(
          `select d::text as day, ${schoolDaysAgoSql('d', '$1::date')} as ago from unnest($2::date[]) d`,
          [today, [today, ...days]],
        )
      ).rows;
      expect(rows, today).toEqual([{ day: today, ago: 0 }, ...days.map((day, i) => ({ day, ago: i + 1 }))]);
    }
  });
});

describe('seed 78 due list is weekday-independent', () => {
  it('always has R5 battery check due before R1 general service, both within the 7-day window', () => {
    const fills = fuelSeries({ schoolCode: 'GWIS-BLR', busCode: 'R1', fuelType: 'diesel', anchorDay: '2026-10-13', anchorReading: 50000, lastDay: '2026-10-12', fromDay: '2026-05-16' });
    for (const today of TODAYS) {
      const due = (busCode: string, type: string) =>
        maintenanceSeries({ schoolCode: 'GWIS-BLR', busCode, fills, busOdometer: 50100, today }).find((r) => r.latest && r.type === type)!.nextDueDate!;
      const r5 = due('R5', 'Battery health check');
      const r1 = due('R1', 'General service');
      expect(r5 < r1, `${today}: R5 ${r5} vs R1 ${r1}`).toBe(true);
      expect(r5 > today && r1 <= addDays(today, 7), today).toBe(true);
    }
  });
});
