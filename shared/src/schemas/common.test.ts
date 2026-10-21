import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PERIOD_RE,
  email,
  exportFormat,
  hhmm,
  idParams,
  isoDate,
  isoDateTime,
  latitude,
  listQuery,
  longitude,
  optionalText,
  periodShape,
  queryBool,
  queryEnumList,
  queryInt,
  queryString,
  semver,
  text,
  timeZone,
  uuid,
  withPeriod,
} from './common.js';

const UUID = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';

describe('uuid()', () => {
  it('accepts a UUID, trims it and lower-cases it', () => {
    expect(uuid().parse(`  ${UUID} `)).toBe(UUID.toLowerCase());
  });
  it('rejects anything else', () => {
    for (const v of ['', 'not-a-uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c330', 123]) expect(uuid().safeParse(v).success).toBe(false);
  });
});

describe('isoDate()', () => {
  it('accepts real calendar days, including 29 February of a leap year', () => {
    expect(isoDate().parse(' 2026-10-19 ')).toBe('2026-10-19');
    expect(isoDate().parse('2028-02-29')).toBe('2028-02-29');
  });
  it('rejects impossible days and other formats', () => {
    for (const v of ['2026-02-29', '2026-13-01', '2026-04-31', '2026-1-1', '19/10/2026', '2026-10-19T00:00:00Z']) {
      expect(isoDate().safeParse(v).success, v).toBe(false);
    }
  });
});

describe('hhmm()', () => {
  it('normalises HH:mm:ss to HH:mm', () => {
    expect(hhmm().parse('07:45')).toBe('07:45');
    expect(hhmm().parse('23:59:59')).toBe('23:59');
  });
  it('rejects out-of-range times', () => {
    for (const v of ['24:00', '7:45', '12:60', '12:00:60']) expect(hhmm().safeParse(v).success, v).toBe(false);
  });
});

describe('isoDateTime()', () => {
  it('accepts instants with a Z or numeric offset', () => {
    expect(isoDateTime().parse('2026-10-19T07:45:00Z')).toBe('2026-10-19T07:45:00Z');
    expect(isoDateTime().parse('2026-10-19T07:45:00.123+05:30')).toBe('2026-10-19T07:45:00.123+05:30');
  });
  it('rejects a timestamp without an offset or a bare date', () => {
    expect(isoDateTime().safeParse('2026-10-19T07:45:00').success).toBe(false);
    expect(isoDateTime().safeParse('2026-10-19').success).toBe(false);
  });
});

describe('latitude() / longitude()', () => {
  it('accept the inclusive bounds', () => {
    expect(latitude().parse(-90)).toBe(-90);
    expect(latitude().parse(90)).toBe(90);
    expect(longitude().parse(-180)).toBe(-180);
    expect(longitude().parse(180)).toBe(180);
  });
  it('reject out-of-range, non-finite and string values', () => {
    expect(latitude().safeParse(90.0001).success).toBe(false);
    expect(longitude().safeParse(-180.0001).success).toBe(false);
    expect(latitude().safeParse(Number.NaN).success).toBe(false);
    expect(longitude().safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    const r = latitude().safeParse('12.9');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('Must be a number');
  });
});

describe('text() / optionalText()', () => {
  it('text trims, requires a value and enforces min/max', () => {
    expect(text().parse('  Bus 1 ')).toBe('Bus 1');
    const empty = text().safeParse('   ');
    expect(empty.success).toBe(false);
    if (!empty.success) expect(empty.error.issues[0]?.message).toBe('Required');
    const short = text(10, 3).safeParse('ab');
    expect(short.success).toBe(false);
    if (!short.success) expect(short.error.issues[0]?.message).toBe('Must be at least 3 characters');
    expect(text(5).safeParse('123456').success).toBe(false);
  });
  it('optionalText maps blank strings to null and keeps undefined', () => {
    expect(optionalText().parse('   ')).toBeNull();
    expect(optionalText().parse(null)).toBeNull();
    expect(optionalText().parse(undefined)).toBeUndefined();
    expect(optionalText().parse(' note ')).toBe('note');
    expect(optionalText(3).safeParse('long').success).toBe(false);
  });
});

describe('email()', () => {
  it('lower-cases and trims a valid address', () => {
    expect(email().parse('  Admin@School.EXAMPLE ')).toBe('admin@school.example');
  });
  it('rejects invalid and over-long addresses', () => {
    expect(email().safeParse('admin@').success).toBe(false);
    expect(email().safeParse(`${'a'.repeat(250)}@x.io`).success).toBe(false);
  });
});

describe('timeZone()', () => {
  it('accepts IANA names and rejects unknown ones', () => {
    expect(timeZone().parse('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(timeZone().parse('UTC')).toBe('UTC');
    expect(timeZone().safeParse('Mars/Olympus_Mons').success).toBe(false);
    expect(timeZone().safeParse('').success).toBe(false);
  });
});

describe('semver()', () => {
  it('accepts MAJOR.MINOR.PATCH with optional pre-release/build suffix', () => {
    for (const v of ['1.2.3', '10.0.0-beta.1', '1.0.0+42']) expect(semver().parse(v)).toBe(v);
  });
  it('rejects incomplete versions', () => {
    for (const v of ['1.2', 'v1.2.3', '1.2.3.4']) expect(semver().safeParse(v).success, v).toBe(false);
  });
});

describe('query-string helpers', () => {
  it('queryString treats blank as absent and caps the length', () => {
    expect(queryString().parse('')).toBeUndefined();
    expect(queryString().parse(' bus ')).toBe('bus');
    expect(queryString(3).safeParse('abcd').success).toBe(false);
  });
  it('queryInt coerces strings and enforces integer bounds', () => {
    expect(queryInt(1, 10).parse('7')).toBe(7);
    expect(queryInt(1, 10).parse('')).toBeUndefined();
    expect(queryInt(1, 10).safeParse('0').success).toBe(false);
    expect(queryInt(1, 10).safeParse('11').success).toBe(false);
    expect(queryInt(1, 10).safeParse('2.5').success).toBe(false);
  });
  it('queryBool understands true/false/1/0 in any case and rejects other words', () => {
    expect(queryBool().parse('TRUE')).toBe(true);
    expect(queryBool().parse('1')).toBe(true);
    expect(queryBool().parse('false')).toBe(false);
    expect(queryBool().parse('0')).toBe(false);
    expect(queryBool().parse(true)).toBe(true);
    expect(queryBool().parse('')).toBeUndefined();
    const r = queryBool().safeParse('yes');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('Must be true or false');
  });
  it('queryEnumList splits comma lists, accepts repeated keys and rejects unknown values', () => {
    const s = queryEnumList(['open', 'closed', 'reviewed']);
    expect(s.parse('open, closed,')).toEqual(['open', 'closed']);
    expect(s.parse(['open', 'reviewed'])).toEqual(['open', 'reviewed']);
    expect(s.parse('')).toBeUndefined();
    expect(s.safeParse('open,deleted').success).toBe(false);
    expect(s.safeParse(',').success).toBe(false);
  });
});

describe('period filter', () => {
  const query = withPeriod(
    z.object({
      ...periodShape,
      from: z.preprocess((v) => (v === '' ? undefined : v), isoDate().optional()),
      to: z.preprocess((v) => (v === '' ? undefined : v), isoDate().optional()),
    }),
  );

  it('PERIOD_RE accepts closed, open-ended and single-day values', () => {
    for (const v of ['2026-10-01..2026-10-31', '2026-10-01..', '..2026-10-31', '..', '2026-10-19']) expect(PERIOD_RE.test(v), v).toBe(true);
    for (const v of ['2026-10-01...2026-10-31', '2026-10-01-2026-10-31', 'last-week']) expect(PERIOD_RE.test(v), v).toBe(false);
  });

  it('expands a range into from/to and removes period', () => {
    expect(query.parse({ period: '2026-10-01..2026-10-31' })).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('expands a single day into from = to', () => {
    expect(query.parse({ period: '2026-10-19' })).toEqual({ from: '2026-10-19', to: '2026-10-19' });
  });

  it('expands an open-ended range on one side only', () => {
    expect(query.parse({ period: '2026-10-01..' })).toEqual({ from: '2026-10-01' });
    expect(query.parse({ period: '..2026-10-31' })).toEqual({ to: '2026-10-31' });
  });

  it('lets explicit from/to win over the period', () => {
    expect(query.parse({ period: '2026-10-01..2026-10-31', from: '2026-10-05' })).toEqual({ from: '2026-10-05', to: '2026-10-31' });
  });

  it('fills a blank explicit from/to from the period', () => {
    expect(query.parse({ period: '2026-10-01..2026-10-31', from: '' })).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('drops a blank period', () => {
    expect(query.parse({ period: '', from: '2026-10-05' })).toEqual({ from: '2026-10-05' });
  });

  it('rejects a malformed period on the period key', () => {
    const r = query.safeParse({ period: 'last-week' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(['period']);
      expect(r.error.issues[0]?.message).toBe('Must be a date range like 2026-10-01..2026-10-31');
    }
  });

  it('passes non-object input through to the wrapped schema', () => {
    expect(query.safeParse(null).success).toBe(false);
    expect(query.safeParse([]).success).toBe(false);
  });
});

describe('pagination and common objects', () => {
  it('exposes the contract page limits', () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(20);
    expect(MAX_PAGE_LIMIT).toBe(100);
  });
  it('listQuery coerces page/limit and enforces bounds', () => {
    expect(listQuery.parse({ page: '2', limit: '50', sort: '-createdAt', q: ' ka01 ' })).toEqual({ page: 2, limit: 50, sort: '-createdAt', q: 'ka01' });
    expect(listQuery.parse({})).toEqual({});
    expect(listQuery.safeParse({ limit: String(MAX_PAGE_LIMIT + 1) }).success).toBe(false);
    expect(listQuery.safeParse({ page: '0' }).success).toBe(false);
  });
  it('exportFormat accepts json/csv/pdf and blank', () => {
    expect(exportFormat.parse('csv')).toBe('csv');
    expect(exportFormat.parse('')).toBeUndefined();
    expect(exportFormat.safeParse('xlsx').success).toBe(false);
  });
  it('idParams lower-cases the id', () => {
    expect(idParams.parse({ id: UUID })).toEqual({ id: UUID.toLowerCase() });
    expect(idParams.safeParse({ id: '42' }).success).toBe(false);
  });
});
