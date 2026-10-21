// Fixtures of the notifications suites: a school with bus R1 on a morning route (Stop 1, Stop 2),
// a running morning trip, students at both stops, parents with different languages / devices /
// link states, a parent linked in a second school, plus capturing push / SMS / socket adapters.
import type { PushChannel, PushMessage, PushResult } from '../src/shared/notifications/push.js';
import type { SmsChannel } from '../src/shared/notifications/sms.js';
import { configureNotificationDeps, type WhatsAppChannel } from '../src/modules/notifications/channels.js';
import { ownerQuery } from './helpers/db.js';
import * as f from './helpers/factories.js';

export interface CapturedEmit {
  room: string;
  event: string;
  payload: Record<string, unknown>;
}

export function fakePush({ enabled = true, invalid = [] as string[] } = {}): PushChannel & { sent: PushMessage[] } {
  const sent: PushMessage[] = [];
  return {
    enabled,
    sent,
    async send(m): Promise<PushResult> {
      sent.push(m);
      if (!enabled) return { successCount: 0, failureCount: 0, invalidTokens: [], skipped: true };
      const bad = m.tokens.filter((t) => invalid.includes(t));
      return { successCount: m.tokens.length - bad.length, failureCount: bad.length, invalidTokens: bad, skipped: false };
    },
  };
}

export function fakeSms(): SmsChannel & { texts: { to: string; text: string; templateId?: string }[] } {
  const texts: { to: string; text: string; templateId?: string }[] = [];
  return {
    provider: 'console',
    texts,
    async sendOtp() {
      return { delivered: true, provider: 'console' };
    },
    async sendText(to, text, opts) {
      texts.push({ to, text, ...(opts?.templateId ? { templateId: opts.templateId } : {}) });
      return { delivered: true, provider: 'console' };
    },
    sendsRealSms: () => false,
    async checkBalance() {
      return { provider: 'console', balance: null, low: false, threshold: 0, checkedAt: new Date().toISOString(), cached: false };
    },
  };
}

export interface Capture {
  push: ReturnType<typeof fakePush>;
  sms: ReturnType<typeof fakeSms>;
  emits: CapturedEmit[];
  restore: () => void;
}

/** Installs capturing adapters (push enabled unless told otherwise). */
export function capture({ push = fakePush(), whatsapp }: { push?: ReturnType<typeof fakePush>; whatsapp?: WhatsAppChannel } = {}): Capture {
  const sms = fakeSms();
  const emits: CapturedEmit[] = [];
  const restore = configureNotificationDeps({
    push,
    sms,
    ...(whatsapp ? { whatsapp } : {}),
    realtime: {
      emit: async (room: string, event: string, payload: unknown) => {
        emits.push({ room, event, payload: payload as Record<string, unknown> });
      },
    },
  });
  return { push, sms, emits, restore };
}

/** A parent phone with a live session (push target). */
export async function parentPhone(parentId: string, token: string, { revoked = false } = {}): Promise<f.Row> {
  const device = await f.device({ owner_type: 'parent_account', owner_id: parentId, school_id: null, app_name: 'parent_app', fcm_token: token });
  await f.session({ owner_type: 'parent_account', owner_id: parentId, school_id: null, device_id: device.id, ...(revoked ? { revoked_at: new Date().toISOString() } : {}) });
  return device;
}

export interface NotifWorld {
  school: f.Row;
  sid: string;
  bus: f.TenantRow;
  route: f.TenantRow;
  stops: f.TenantRow[];
  trip: f.TenantRow;
  students: { aarav: f.TenantRow; diya: f.TenantRow; kabir: f.TenantRow; inactive: f.TenantRow; future: f.TenantRow };
  /** pA en (Aarav, token tok-a), pB hi (Aarav + Diya, token tok-b), pC (Kabir, no phone), pD (Diya, inactive link). */
  parents: { pA: f.Row; pB: f.Row; pC: f.Row; pD: f.Row };
}

/** Links a parent to a school and students. */
export async function linkParent(sid: string, parentId: string, studentIds: string[], o: f.Values = {}): Promise<void> {
  await f.schoolParent(sid, parentId, o);
  for (const id of studentIds) await f.studentParent(sid, id, parentId);
}

export async function notifWorld({ settings = {}, tripStatus = 'in_progress' }: { settings?: f.Values; tripStatus?: string } = {}): Promise<NotifWorld> {
  const school = await f.school({ name: 'Greenwood Notify School', timezone: 'Asia/Kolkata' });
  const sid = school.id;
  await f.schoolSubscription(sid);
  if (Object.keys(settings).length) await f.schoolSettings(sid, settings);
  const bus = await f.bus(sid, { code: 'R1' });
  const route = await f.route(sid, { code: 'R1', name: 'Route 1', direction: 'morning' });
  const stops = [
    await f.stop(sid, route.id, { name: 'Indiranagar 100ft Road', sequence: 1, expected_time: '07:10:00' }),
    await f.stop(sid, route.id, { name: 'Domlur Flyover', sequence: 2, latitude: 12.96, longitude: 77.64, expected_time: '07:20:00' }),
  ];
  const tripValues = tripStatus === 'in_progress'
    ? { status: 'in_progress', started_at: new Date().toISOString(), start_odometer: 1000 }
    : { status: tripStatus, planned_start_at: new Date(Date.now() - 30 * 60_000).toISOString() };
  const trip = await f.trip(sid, bus.id, { route_id: route.id, direction: 'morning', bus_code_snapshot: 'R1', route_code_snapshot: 'R1', ...tripValues });
  const assign = (studentId: string, stopId: string, o: f.Values = {}) => f.studentAssignment(sid, { studentId, busId: bus.id, routeId: route.id, stopId }, o);
  const aarav = await f.student(sid, { full_name: 'Aarav Kumar Sharma' });
  const diya = await f.student(sid, { full_name: 'Diya Patel' });
  const kabir = await f.student(sid, { full_name: 'Kabir Singh' });
  const inactive = await f.student(sid, { full_name: 'Ishaan Rao', is_active: false });
  const future = await f.student(sid, { full_name: 'Meera Nair' });
  await assign(aarav.id, stops[0]!.id);
  await assign(diya.id, stops[0]!.id);
  await assign(kabir.id, stops[1]!.id);
  await assign(inactive.id, stops[0]!.id);
  await assign(future.id, stops[0]!.id, { valid_from: f.isoDay(5) });
  const pA = await f.parentAccount({ display_name: 'Priya Sharma', preferred_language: 'en' });
  const pB = await f.parentAccount({ display_name: 'Rakesh Patel', preferred_language: 'hi' });
  const pC = await f.parentAccount({ display_name: 'Simran Singh' });
  const pD = await f.parentAccount({ display_name: 'Old Guardian' });
  await linkParent(sid, pA.id, [aarav.id, inactive.id, future.id]);
  await linkParent(sid, pB.id, [aarav.id, diya.id]);
  await linkParent(sid, pC.id, [kabir.id]);
  await linkParent(sid, pD.id, [diya.id], { is_active: false });
  await parentPhone(pA.id, 'tok-a');
  await parentPhone(pB.id, 'tok-b');
  await parentPhone(pB.id, 'tok-b-old', { revoked: true });
  return { school, sid, bus, route, stops, trip, students: { aarav, diya, kabir, inactive, future }, parents: { pA, pB, pC, pD } };
}

export async function eventsOf(tripId: string) {
  const { rows } = await ownerQuery<{ id: string; student_id: string; event_type: string; status: string; channel: string; error: string | null; payload: Record<string, unknown>; sent_at: string | null }>(
    'select id, student_id, event_type, status, channel, error, payload, sent_at from notification_events where trip_id = $1 order by created_at, student_id',
    [tripId],
  );
  return rows;
}

export async function inboxOf(parentId: string) {
  const { rows } = await ownerQuery<{ id: string; school_id: string; student_id: string | null; trip_id: string | null; kind: string; title: string; body: string; data: Record<string, string>; notification_event_id: string | null }>(
    'select id, school_id, student_id, trip_id, kind, title, body, data, notification_event_id from parent_notifications where parent_account_id = $1 order by created_at, id',
    [parentId],
  );
  return rows;
}
