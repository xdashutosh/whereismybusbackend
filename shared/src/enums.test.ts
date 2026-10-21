import { describe, expect, it } from 'vitest';
import * as enums from './enums.js';
import {
  ACTOR_ROLES,
  ALERT_SEVERITIES,
  ERROR_CODES,
  ERROR_STATUS,
  HARSH_DRIVING_EVENT_TYPES,
  DEVICE_EVENT_TYPES,
  HEADERS,
  LOCATION_PERMISSION_EVENT_TYPES,
  NOTIFICATION_EVENTS,
  PARENT_TRIP_EVENTS,
  ROLES,
  SCHOOL_USER_ROLES,
  SOCKET_EVENTS,
  SOCKET_NAMESPACE,
  STAFF_TYPES,
  SYSTEM_ACTOR_ROLE,
  TRIP_NOTICE_EVENTS,
} from './enums.js';
import { API_PREFIX } from './api.js';

// Every exported readonly tuple (the enums that feed z.enum and the database CHECK constraints).
const tuples = (Object.entries(enums) as [string, unknown][]).filter((e): e is [string, readonly string[]] => Array.isArray(e[1]));

describe('enum tuples', () => {
  it('are exported', () => {
    expect(tuples.length).toBeGreaterThan(30);
  });

  it.each(tuples)('%s is non-empty, unique and snake_case-safe', (_name, values) => {
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  });
});

describe('role and event relationships', () => {
  it('school user roles and staff types are platform roles', () => {
    for (const r of SCHOOL_USER_ROLES) expect(ROLES).toContain(r);
    for (const s of STAFF_TYPES) expect(ROLES).toContain(s);
  });

  it('actor roles are every role plus the system actor', () => {
    expect(ACTOR_ROLES).toEqual([...ROLES, SYSTEM_ACTOR_ROLE]);
  });

  it('harsh-driving and location-permission events are device event types', () => {
    for (const e of [...HARSH_DRIVING_EVENT_TYPES, ...LOCATION_PERMISSION_EVENT_TYPES]) expect(DEVICE_EVENT_TYPES).toContain(e);
  });

  it('parent trip events are the notification events followed by the trip notices', () => {
    expect(PARENT_TRIP_EVENTS).toEqual([...NOTIFICATION_EVENTS, ...TRIP_NOTICE_EVENTS]);
  });

  it('alert severities are ordered from lowest to highest', () => {
    expect(ALERT_SEVERITIES).toEqual(['info', 'warning', 'critical']);
  });
});

describe('error codes', () => {
  it('ERROR_STATUS maps exactly the error codes', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('maps every code to a 4xx/5xx status', () => {
    for (const code of ERROR_CODES) {
      const status = ERROR_STATUS[code];
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
  });

  it('keeps the contract statuses of the codes clients branch on', () => {
    expect(ERROR_STATUS.VALIDATION_ERROR).toBe(400);
    expect(ERROR_STATUS.UNAUTHENTICATED).toBe(401);
    expect(ERROR_STATUS.TOKEN_EXPIRED).toBe(401);
    expect(ERROR_STATUS.FORBIDDEN).toBe(403);
    expect(ERROR_STATUS.APP_UPDATE_REQUIRED).toBe(426);
    expect(ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_STATUS.INTERNAL_ERROR).toBe(500);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ERROR_STATUS)).toBe(true);
  });
});

describe('realtime and HTTP constants', () => {
  it('socket events are unique and frozen', () => {
    const values = Object.values(SOCKET_EVENTS);
    expect(new Set(values).size).toBe(values.length);
    expect(Object.isFrozen(SOCKET_EVENTS)).toBe(true);
    expect(SOCKET_NAMESPACE).toBe('/rt');
  });

  it('header names are unique and frozen', () => {
    const values = Object.values(HEADERS).map((h) => h.toLowerCase());
    expect(new Set(values).size).toBe(values.length);
    expect(Object.isFrozen(HEADERS)).toBe(true);
  });

  it('API prefix is versioned', () => {
    expect(API_PREFIX).toBe('/api/v1');
  });
});
