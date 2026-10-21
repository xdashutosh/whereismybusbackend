// Audit helper (with a capturing Tx), phone normalisation and notification channel adapters
// (fake fetch — no network).
import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../src/db/pool.js';
import type { Tx } from '../src/db/tenant.js';
import { AUDIT_INSERT_SQL, audit, changedFields, redactSecrets } from '../src/shared/audit.js';
import { createEmailChannel } from '../src/shared/notifications/email.js';
import { createNoopPush } from '../src/shared/notifications/push.js';
import { createConsoleSms } from '../src/shared/notifications/sms.js';
import { maskPhone, normalizePhone, phoneE164 } from '../src/shared/phone.js';
import { runWithRequestContext } from '../src/shared/requestContext.js';

const SCHOOL = '5c000000-0000-4000-8000-000000000001';
const ACTOR = 'ac000000-0000-4000-8000-0000000000ac';

function captureTx(role: Tx['ctx']['role'] = 'school_admin') {
  const calls: { text: string; params: readonly unknown[] }[] = [];
  const tx = {
    ctx: { schoolId: SCHOOL, actorId: ACTOR, role },
    readOnly: false,
    query: async (text: string, params: readonly unknown[] = []) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 1 } as unknown as QueryResult;
    },
  } as unknown as Tx;
  return { tx, calls };
}

describe('audit', () => {
  it('redacts secrets recursively and computes changed fields', () => {
    expect(redactSecrets({ name: 'A', passwordHash: 'x', nested: { otp: '1', list: [{ refreshToken: 't', ok: 1 }] } })).toEqual({
      name: 'A',
      passwordHash: '[REDACTED]',
      nested: { otp: '[REDACTED]', list: [{ refreshToken: '[REDACTED]', ok: 1 }] },
    });
    expect(changedFields({ a: 1, b: 2, c: null }, { a: 1, b: 3, d: 4 })).toEqual({ old: { b: 2, d: null }, new: { b: 3, d: 4 } });
  });

  it('writes one row in the caller transaction with request context', async () => {
    const { tx, calls } = captureTx();
    await runWithRequestContext({ requestId: 'r1', ip: '10.0.0.1', userAgent: 'vitest', actorName: 'Principal' }, () =>
      audit.log(tx, { action: 'bus.update', entityType: 'bus', entityId: 'e1', old: { code: 'R1' }, new: { code: 'R2', pin: '1234' } }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(AUDIT_INSERT_SQL);
    expect(calls[0]!.params).toEqual([SCHOOL, 'user', ACTOR, 'Principal', '10.0.0.1', 'vitest', 'bus.update', 'bus', 'e1', '{"code":"R1"}', '{"code":"R2","pin":"[REDACTED]"}', 'r1']);
  });

  it('maps actor types and validates action names', async () => {
    const { tx, calls } = captureTx('super_admin');
    await audit.log(tx, { action: 'school.create' });
    expect(calls[0]!.params.slice(1, 6)).toEqual(['platform_user', ACTOR, null, null, null]);
    await expect(audit.log(tx, { action: 'Bad Action' })).rejects.toThrow(/Invalid audit action/);
  });
});

describe('phone', () => {
  it('normalises Indian numbers to E.164 and masks them', () => {
    expect(normalizePhone('98450 12345')).toBe('+919845012345');
    expect(normalizePhone('+91-98450-12345')).toBe('+919845012345');
    expect(normalizePhone('09845012345')).toBe('+919845012345');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone(42)).toBeNull();
    expect(maskPhone('+919845012345')).toBe('+91******2345');
    expect(phoneE164().safeParse('9845012345')).toEqual({ success: true, data: '+919845012345' });
    expect(phoneE164().safeParse('abc').success).toBe(false);
  });
});

describe('sms channels', () => {
  it('console provider always delivers (development; WebPay Services is covered in sms.webpay.test.ts)', async () => {
    const sms = createConsoleSms();
    expect(await sms.sendOtp('+919845012345', '123456')).toEqual({ delivered: true, provider: 'console', simulated: true });
    expect((await sms.sendText('+919845012345', 'hello')).delivered).toBe(true);
    expect(sms.sendsRealSms('+919845012345')).toBe(false);
    expect(await sms.checkBalance()).toMatchObject({ provider: 'console', balance: null, low: false });
  });
});

describe('push and email channels', () => {
  it('push without Firebase is a logged no-op', async () => {
    const push = createNoopPush();
    expect(push.enabled).toBe(false);
    expect(await push.send({ tokens: ['a'], title: 'Bus R1', body: 'Trip started' })).toEqual({ successCount: 0, failureCount: 0, invalidTokens: [], skipped: true });
  });

  it('email without SMTP is logged and kept for tests', async () => {
    const email = createEmailChannel({ smtp: { enabled: false, host: null, port: 587, secure: false, user: null, pass: null, from: 'x@y' }, keepMessages: true });
    expect(await email.send({ to: 'a@b.c', subject: 'Welcome', text: 'Hello' })).toEqual({ delivered: false, transport: 'log' });
    expect(email.sentMessages()).toHaveLength(1);
    email.clearSentMessages();
    expect(email.sentMessages()).toHaveLength(0);
    await expect(email.send({ to: '', subject: 's', text: 't' })).rejects.toThrow(TypeError);
  });
});
