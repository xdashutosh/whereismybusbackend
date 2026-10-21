// Seed 20 · school module demo data (contract §14): for every demo tenant that exists (01 seeds
// Greenwood and Sunrise; Lakeview and Riverside are picked up when another seed creates them):
//   · a second school admin (transport coordinator) — same demo password as the other accounts
//   · the 2026–27 holiday calendar (national + state holidays, one afternoon-only day)
//   · announcements: pinned parent notice, driver notice, a scheduled PTM notice, an expired one
//   · settings: speed limit + speeding alerts, both admins as alert recipients (Riverside College
//     also allows non-school trips) — only while the school has never saved its settings
// Idempotent: rows are matched by natural keys (admin e-mail, holiday name + start, title) and
// settings are only touched while updated_by is NULL. One batched statement per table.
import type { SeedContext } from '../seed.js';

interface SchoolSeed {
  code: string;
  speedLimitKmh: number;
  allowNonSchoolTrips: boolean;
  admin: { name: string; email: string; phone: string };
  stateHolidays: { name: string; start: string; end: string }[];
}

export const SCHOOL_SEEDS: readonly SchoolSeed[] = [
  {
    code: 'GWIS-BLR',
    speedLimitKmh: 50,
    allowNonSchoolTrips: false,
    admin: { name: 'Arjun Nair', email: 'transport@greenwood.example', phone: '+919845000110' },
    stateHolidays: [{ name: 'Kannada Rajyotsava', start: '2026-11-01', end: '2026-11-01' }],
  },
  {
    code: 'SUNRISE-JPR',
    speedLimitKmh: 45,
    allowNonSchoolTrips: false,
    admin: { name: 'Neha Agarwal', email: 'transport@sunrise.example', phone: '+919829000210' },
    stateHolidays: [{ name: 'Rajasthan Diwas', start: '2027-03-30', end: '2027-03-30' }],
  },
  {
    code: 'LAKEVIEW-HYD',
    speedLimitKmh: 50,
    allowNonSchoolTrips: false,
    admin: { name: 'Srinivas Reddy', email: 'transport@lakeview.example', phone: '+919849000310' },
    stateHolidays: [{ name: 'Telangana Formation Day', start: '2027-06-02', end: '2027-06-02' }],
  },
  {
    code: 'RIVERSIDE-COK',
    speedLimitKmh: 60,
    allowNonSchoolTrips: true,
    admin: { name: 'Anjali Thomas', email: 'transport@riverside.example', phone: '+919847000410' },
    stateHolidays: [{ name: 'Kerala Piravi', start: '2026-11-01', end: '2026-11-01' }],
  },
];

/** Holidays every demo school observes (end inclusive; applies_to 'all' unless stated). */
export const COMMON_HOLIDAYS = [
  { name: 'Diwali break', start: '2026-11-08', end: '2026-11-10', appliesTo: 'all' },
  { name: 'Annual Day (no afternoon trips)', start: '2026-12-12', end: '2026-12-12', appliesTo: 'afternoon' },
  { name: 'Christmas', start: '2026-12-25', end: '2026-12-25', appliesTo: 'all' },
  { name: 'Republic Day', start: '2027-01-26', end: '2027-01-26', appliesTo: 'all' },
  { name: 'Holi', start: '2027-03-22', end: '2027-03-22', appliesTo: 'all' },
] as const;

/** Announcements per school (offsets relative to the seed run, in hours). */
export const DEMO_ANNOUNCEMENTS = [
  {
    title: 'Live bus tracking is now available',
    body: 'Track your child’s bus live in the Where Is My Bus parent app. Sign in with the mobile number registered at the school office.',
    audience: 'parents', pinned: true, publishedHours: -48, expiresHours: null,
  },
  {
    title: 'Carry your licence and the bus documents on every trip',
    body: 'Drivers and conductors: keep your licence, the insurance and the fitness certificate copies in the bus. Start each trip only after the odometer photo is accepted.',
    audience: 'drivers', pinned: false, publishedHours: -24, expiresHours: null,
  },
  {
    title: 'Parent-teacher meeting on Saturday',
    body: 'Morning buses run 30 minutes later on the PTM day. Afternoon trips are unchanged.',
    audience: 'all', pinned: false, publishedHours: 72, expiresHours: 168,
  },
  {
    title: 'Route R1 diversion during road works (ended)',
    body: 'The diversion is over; buses are back on the regular route.',
    audience: 'all', pinned: false, publishedHours: -480, expiresHours: -240,
  },
] as const;

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger, passwordHash, remoteTarget } = ctx;
  await ctx.setContext({ schoolId: null, actorId: null, role: 'system' });
  const codes = SCHOOL_SEEDS.map((s) => s.code);
  const present = await tx.many<{ code: string }>('select code from schools where code = any ($1) and deleted_at is null', [codes]);
  if (!present.length) {
    logger.info('No demo schools found — school seed skipped');
    return;
  }

  await tx.query(
    `insert into users (school_id, role, full_name, email, phone, password_hash, must_change_password)
     select s.id, 'school_admin', v.name, v.email, v.phone, $5, $6
       from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as v(code, name, email, phone)
       join schools s on s.code = v.code and s.deleted_at is null
     on conflict do nothing`,
    [SCHOOL_SEEDS.map((s) => s.code), SCHOOL_SEEDS.map((s) => s.admin.name), SCHOOL_SEEDS.map((s) => s.admin.email), SCHOOL_SEEDS.map((s) => s.admin.phone), passwordHash, remoteTarget],
  );

  const holidays = SCHOOL_SEEDS.flatMap((s) => [
    ...COMMON_HOLIDAYS.map((h) => ({ code: s.code, ...h })),
    ...s.stateHolidays.map((h) => ({ code: s.code, ...h, appliesTo: 'all' })),
  ]);
  await tx.query(
    `insert into school_holidays (school_id, name, start_date, end_date, applies_to)
     select s.id, v.name, v.start_date, v.end_date, v.applies_to
       from unnest($1::text[], $2::text[], $3::date[], $4::date[], $5::text[]) as v(code, name, start_date, end_date, applies_to)
       join schools s on s.code = v.code and s.deleted_at is null
      where not exists (select 1 from school_holidays h where h.school_id = s.id and lower(h.name) = lower(v.name) and h.start_date = v.start_date)`,
    [holidays.map((h) => h.code), holidays.map((h) => h.name), holidays.map((h) => h.start), holidays.map((h) => h.end), holidays.map((h) => h.appliesTo)],
  );

  await tx.query(
    `insert into announcements (school_id, title, body, audience, is_pinned, published_at, expires_at, created_by)
     select s.id, v.title, v.body, v.audience, v.pinned,
            now() + make_interval(hours => v.published_h),
            case when v.expires_h is null then null else now() + make_interval(hours => v.expires_h) end,
            (select u.id from users u where u.school_id = s.id and u.role = 'school_admin' and u.deleted_at is null order by u.created_at, u.id limit 1)
       from unnest($1::text[], $2::text[], $3::text[], $4::boolean[], $5::int[], $6::int[]) as v(title, body, audience, pinned, published_h, expires_h)
       cross join schools s
      where s.code = any ($7::text[]) and s.deleted_at is null
        and not exists (select 1 from announcements a where a.school_id = s.id and a.title = v.title and a.deleted_at is null)`,
    [
      DEMO_ANNOUNCEMENTS.map((a) => a.title),
      DEMO_ANNOUNCEMENTS.map((a) => a.body),
      DEMO_ANNOUNCEMENTS.map((a) => a.audience),
      DEMO_ANNOUNCEMENTS.map((a) => a.pinned),
      DEMO_ANNOUNCEMENTS.map((a) => a.publishedHours),
      DEMO_ANNOUNCEMENTS.map((a) => a.expiresHours),
      codes,
    ],
  );

  await tx.query(
    `update school_settings ss
        set speed_limit_kmh = v.speed_limit, enable_speeding_alert = true, allow_non_school_trips = v.non_school,
            alert_recipients = coalesce((
              select jsonb_agg(jsonb_build_object('user_id', u.id, 'name', null, 'email', null, 'phone', null,
                                                  'min_severity', 'warning', 'alert_types', null) order by u.created_at, u.id)
                from users u
               where u.school_id = ss.school_id and u.role = 'school_admin' and u.is_active and u.deleted_at is null), '[]'::jsonb),
            updated_at = now()
       from unnest($1::text[], $2::int[], $3::boolean[]) as v(code, speed_limit, non_school)
       join schools s on s.code = v.code and s.deleted_at is null
      where ss.school_id = s.id and ss.updated_by is null`,
    [SCHOOL_SEEDS.map((s) => s.code), SCHOOL_SEEDS.map((s) => s.speedLimitKmh), SCHOOL_SEEDS.map((s) => s.allowNonSchoolTrips)],
  );

  logger.info(
    { schools: present.map((p) => p.code), admins: SCHOOL_SEEDS.filter((s) => present.some((p) => p.code === s.code)).map((s) => s.admin.email) },
    'School seed applied (admins, holidays, announcements, settings)',
  );
}
