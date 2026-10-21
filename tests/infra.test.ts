// Small infrastructure units: typed event bus, module registry, room registry, request context,
// logger redaction, shared package wiring.
import { Writable } from 'node:stream';
import { API_PREFIX, ROLES, SOCKET_NAMESPACE } from '@wimb/shared';
import { describe, expect, it } from 'vitest';
import { modules } from '../src/modules/index.js';
import { createEventBus } from '../src/shared/events.js';
import { createLogger, sanitizeUrl } from '../src/shared/logger.js';
import { createRoomRegistry } from '../src/shared/realtime.js';
import { getRequestContext, runWithRequestContext, updateRequestContext } from '../src/shared/requestContext.js';

describe('event bus', () => {
  it('delivers asynchronously and isolates failing listeners', async () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.on('school.status_changed', () => {
      throw new Error('listener bug');
    });
    const off = bus.on('school.status_changed', ({ schoolId, status }) => void seen.push(`${schoolId}:${status}`));
    expect(bus.emit('school.status_changed', { schoolId: 's1', status: 'suspended' })).toBe(2);
    expect(seen).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['s1:suspended']);
    expect(bus.stats().failures).toBe(1);
    off();
    expect(await bus.emitAndWait('school.status_changed', { schoolId: 's2', status: 'active' })).toBe(1);
    expect(seen).toHaveLength(1);
  });
});

describe('module registry', () => {
  it('mounts one router per BP §7.1 module', () => {
    expect(modules.map((m) => m.name)).toEqual(['auth', 'platform', 'school', 'users', 'staff', 'buses', 'routes', 'students', 'trips', 'tracking', 'alerts', 'fuel', 'maintenance', 'reports', 'parent', 'files', 'notifications', 'audit', 'privacy']);
    expect(API_PREFIX).toBe('/api/v1');
    expect(SOCKET_NAMESPACE).toBe('/rt');
    expect(ROLES).toContain('conductor');
  });
});

describe('room registry', () => {
  it('matches UUID parameters and validates patterns', () => {
    const reg = createRoomRegistry();
    reg.register('child:{studentId}:live', async () => true);
    const id = '5d000000-0000-4000-8000-00000000005d';
    expect(reg.match(`child:${id}:live`)?.params).toEqual({ studentId: id });
    expect(reg.match('child:x:live')).toBeNull();
    expect(reg.match(`child:${id}:live:extra`)).toBeNull();
    expect(() => reg.register('child:{studentId}:live', async () => true)).toThrow(/already registered/);
    expect(() => reg.register('Bad Pattern', async () => true)).toThrow(/Invalid room pattern/);
    expect(reg.patterns()).toEqual(['child:{studentId}:live']);
  });
});

describe('request context', () => {
  it('is scoped to the async call chain', async () => {
    expect(getRequestContext()).toBeUndefined();
    await runWithRequestContext({ requestId: 'r1', ip: null, userAgent: null }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      updateRequestContext({ schoolId: 's1' });
      expect(getRequestContext()).toMatchObject({ requestId: 'r1', schoolId: 's1' });
    });
    updateRequestContext({ schoolId: 'ignored' });
    expect(getRequestContext()).toBeUndefined();
  });
});

describe('logger', () => {
  it('redacts secrets and sensitive query parameters', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = createLogger({ level: 'info', destination: sink });
    log.info({ password: 'p', user: { refreshToken: 'r', name: 'n' }, sms: { otp: '123456' } }, 'x');
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.user).toEqual({ refreshToken: '[REDACTED]', name: 'n' });
    expect(entry.sms).toEqual({ otp: '[REDACTED]' });
    expect(sanitizeUrl('/x?token=abc&page=2&X-Amz-Signature=s')).toBe('/x?token=[REDACTED]&page=2&X-Amz-Signature=[REDACTED]');
  });
});
