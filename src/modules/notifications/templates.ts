// Lock-screen-safe notification templates (BP §11.2): English + Hindi. Trip messages carry ONLY the
// child's first name and the bus code (plus a rounded minute count where the event needs one) —
// never the full name, class, stop name, address, driver details or coordinates. Pure functions.
import type { Direction, ParentTripEvent, NotificationLanguage } from '@wimb/shared';

export interface TripTemplateVars {
  /** First name only (firstNameOf(full_name)). */
  childFirstName: string;
  busCode: string;
  direction: Direction;
  /** approaching_stop: minutes to the stop; trip_delayed: minutes late. */
  minutes?: number | null;
}

export interface RenderedMessage {
  title: string;
  body: string;
}

/** Push titles stay short; bodies fit one lock-screen line or two. */
export const MAX_PUSH_TITLE = 65;
export const MAX_PUSH_BODY = 178;
/** parent_notifications.title / body limits (migration 008). */
export const MAX_INBOX_TITLE = 200;
export const MAX_INBOX_BODY = 2000;

const DIRECTION_WORD: Record<NotificationLanguage, Record<Direction, string>> = {
  en: { morning: 'morning', afternoon: 'afternoon' },
  hi: { morning: 'सुबह', afternoon: 'दोपहर' },
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

type Builder = (v: Required<Pick<TripTemplateVars, 'childFirstName' | 'busCode'>> & { dir: string; minutes: number }) => RenderedMessage;

const TEMPLATES: Record<NotificationLanguage, Record<ParentTripEvent, Builder>> = {
  en: {
    trip_started: (v) => ({ title: `Bus ${v.busCode} has started`, body: `The ${v.dir} trip of bus ${v.busCode} for ${v.childFirstName} has started.` }),
    bus_left_school: (v) => ({ title: `Bus ${v.busCode} left school`, body: `Bus ${v.busCode} (${v.childFirstName}'s ${v.dir} bus) has left the school.` }),
    approaching_stop: (v) => ({
      title: `Bus ${v.busCode} is almost there`,
      body: `Bus ${v.busCode} is about ${v.minutes} ${plural(v.minutes, 'minute', 'minutes')} away from ${v.childFirstName}'s stop.`,
    }),
    arrived_at_stop: (v) => ({ title: `Bus ${v.busCode} has arrived`, body: `Bus ${v.busCode} has reached ${v.childFirstName}'s stop.` }),
    trip_delayed: (v) => ({
      title: `Bus ${v.busCode} is running late`,
      body: `Bus ${v.busCode} is running about ${v.minutes} ${plural(v.minutes, 'minute', 'minutes')} late for ${v.childFirstName}'s stop.`,
    }),
    trip_not_started: (v) => ({ title: `Bus ${v.busCode} has not started`, body: `The ${v.dir} trip of bus ${v.busCode} for ${v.childFirstName} has not started yet.` }),
    trip_interrupted: (v) => ({
      title: `Bus ${v.busCode} trip interrupted`,
      body: `The ${v.dir} trip of bus ${v.busCode} for ${v.childFirstName} has been interrupted. The school will share an update.`,
    }),
    trip_cancelled: (v) => ({
      title: `Bus ${v.busCode} trip cancelled`,
      body: `The ${v.dir} trip of bus ${v.busCode} for ${v.childFirstName} has been cancelled by the school.`,
    }),
  },
  hi: {
    trip_started: (v) => ({ title: `बस ${v.busCode} चल पड़ी है`, body: `${v.childFirstName} की ${v.dir} की बस ${v.busCode} की यात्रा शुरू हो गई है।` }),
    bus_left_school: (v) => ({ title: `बस ${v.busCode} ने स्कूल छोड़ा`, body: `${v.childFirstName} की ${v.dir} की बस ${v.busCode} स्कूल से निकल गई है।` }),
    approaching_stop: (v) => ({ title: `बस ${v.busCode} पहुँचने वाली है`, body: `बस ${v.busCode} ${v.childFirstName} के स्टॉप से लगभग ${v.minutes} मिनट दूर है।` }),
    arrived_at_stop: (v) => ({ title: `बस ${v.busCode} पहुँच गई है`, body: `बस ${v.busCode} ${v.childFirstName} के स्टॉप पर पहुँच गई है।` }),
    trip_delayed: (v) => ({ title: `बस ${v.busCode} देरी से चल रही है`, body: `बस ${v.busCode} ${v.childFirstName} के स्टॉप के लिए लगभग ${v.minutes} मिनट देरी से चल रही है।` }),
    trip_not_started: (v) => ({ title: `बस ${v.busCode} अभी शुरू नहीं हुई`, body: `${v.childFirstName} की ${v.dir} की बस ${v.busCode} की यात्रा अभी शुरू नहीं हुई है।` }),
    trip_interrupted: (v) => ({
      title: `बस ${v.busCode} की यात्रा रुक गई है`,
      body: `${v.childFirstName} की ${v.dir} की बस ${v.busCode} की यात्रा बीच में रुक गई है। स्कूल जल्द जानकारी देगा।`,
    }),
    trip_cancelled: (v) => ({ title: `बस ${v.busCode} की यात्रा रद्द`, body: `${v.childFirstName} की ${v.dir} की बस ${v.busCode} की यात्रा स्कूल ने रद्द कर दी है।` }),
  },
};

/** Collapses whitespace and cuts at `max` characters (with an ellipsis). */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** First given name of a full name ("Aarav Kumar Sharma" → "Aarav"); never the surname. */
export function firstNameOf(fullName: string | null | undefined): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  return clip(first, 40);
}

/** Used when a student record has no usable name. */
const CHILD_FALLBACK: Record<NotificationLanguage, string> = { en: 'your child', hi: 'आपके बच्चे' };

/** Bus codes are short school codes (R1); anything else is cut. */
const safeBusCode = (code: string | null | undefined) => clip((code ?? '').trim(), 20) || '-';

/** Normalises a stored language preference. */
export function languageOf(v: string | null | undefined): NotificationLanguage {
  return v === 'hi' ? 'hi' : 'en';
}

/** Renders a parent trip notification (push + inbox text share it). */
export function renderTripMessage(event: ParentTripEvent, lang: NotificationLanguage, vars: TripTemplateVars): RenderedMessage {
  const minutes = Math.max(1, Math.round(vars.minutes ?? 1));
  const childFirstName = firstNameOf(vars.childFirstName) || CHILD_FALLBACK[lang];
  const msg = TEMPLATES[lang][event]({ childFirstName, busCode: safeBusCode(vars.busCode), dir: DIRECTION_WORD[lang][vars.direction], minutes });
  return { title: clip(msg.title, MAX_PUSH_TITLE), body: clip(msg.body, MAX_PUSH_BODY) };
}

const ANNOUNCEMENT_TITLE: Record<NotificationLanguage, string> = { en: 'New notice from school', hi: 'स्कूल से नई सूचना' };

/**
 * Announcement messages. The lock screen shows a generic title and the announcement's own title;
 * the inbox entry keeps the school-written title and body (cut to the inbox limits).
 */
export function renderAnnouncement(lang: NotificationLanguage, a: { title: string; body: string }): { push: RenderedMessage; inbox: RenderedMessage } {
  return {
    push: { title: ANNOUNCEMENT_TITLE[lang], body: clip(a.title, MAX_PUSH_BODY) },
    inbox: { title: clip(a.title, MAX_INBOX_TITLE), body: a.body.length > MAX_INBOX_BODY ? `${a.body.slice(0, MAX_INBOX_BODY - 1)}…` : a.body },
  };
}
