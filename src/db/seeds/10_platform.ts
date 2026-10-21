// Seed 10 · platform (contract §9, §14): the two remaining demo tenants of contract §14 —
// Lakeview Academy (LAKEVIEW-HYD, Hyderabad, Telangana) and Riverside College (RIVERSIDE-COK, Kochi,
// Kerala, institution_type college) — each onboarded the way POST /platform/schools does it: school
// (+ school_settings defaults by trigger), initial school admin, a subscription with its own plan and
// limits, and a platform audit entry. Demo admins use the seed password (ctx.passwordHash) and only
// have to change it on a non-local database (remoteTarget), like seed 01. Idempotent: existing
// schools, admins and subscriptions are left untouched; audit rows are written only for schools
// created by this run.
import type { SeedContext } from '../seed.js';

export const PLATFORM_DEMO_SCHOOLS = [
  {
    code: 'LAKEVIEW-HYD',
    name: 'Lakeview Academy',
    institutionType: 'school',
    address: '6-3-1090, Raj Bhavan Road, Somajiguda',
    city: 'Hyderabad',
    state: 'Telangana',
    pincode: '500082',
    latitude: 17.423908,
    longitude: 78.458282,
    brandColor: '#0B5394',
    contactName: 'Kavya Reddy',
    contactPhone: '+914023350000',
    contactEmail: 'office@lakeview.example',
    admin: { name: 'Kavya Reddy', email: 'admin@lakeview.example', phone: '+919849000300' },
    subscription: { plan: 'standard', maxBuses: 12, maxStudents: 900, validForDays: 45, modules: { push: true, sms: false, whatsapp: false } },
  },
  {
    code: 'RIVERSIDE-COK',
    name: 'Riverside College',
    institutionType: 'college',
    address: 'Infopark Road, Kakkanad',
    city: 'Kochi',
    state: 'Kerala',
    pincode: '682042',
    latitude: 10.015861,
    longitude: 76.341867,
    brandColor: '#7A1F5C',
    contactName: 'Anil Menon',
    contactPhone: '+914842415000',
    contactEmail: 'office@riverside.example',
    admin: { name: 'Anil Menon', email: 'admin@riverside.example', phone: '+919847000400' },
    subscription: { plan: 'premium', maxBuses: 20, maxStudents: 2500, validForDays: 365, modules: { push: true, sms: true, whatsapp: false, reports: true } },
  },
] as const;

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger, passwordHash, remoteTarget } = ctx;
  const S = PLATFORM_DEMO_SCHOOLS;

  // Schools, subscriptions and platform audit rows are platform rows (super admin context).
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });
  const inserted = await tx.many<{ id: string; code: string }>(
    `insert into schools (code, name, institution_type, address, city, state, pincode, latitude, longitude, brand_color,
                          contact_name, contact_phone, contact_email, timezone)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[],
                          $9::numeric[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[])
     on conflict (code) do nothing
     returning id, code`,
    [
      S.map((s) => s.code),
      S.map((s) => s.name),
      S.map((s) => s.institutionType),
      S.map((s) => s.address),
      S.map((s) => s.city),
      S.map((s) => s.state),
      S.map((s) => s.pincode),
      S.map((s) => s.latitude),
      S.map((s) => s.longitude),
      S.map((s) => s.brandColor),
      S.map((s) => s.contactName),
      S.map((s) => s.contactPhone),
      S.map((s) => s.contactEmail),
      S.map(() => 'Asia/Kolkata'),
    ],
  );
  const schools = await tx.many<{ id: string; code: string }>('select id, code from schools where code = any ($1)', [S.map((s) => s.code)]);
  const idOf = new Map(schools.map((s) => [s.code, s.id]));

  // One active subscription per school; valid_until relative to the school-local date.
  await tx.query(
    `insert into school_subscriptions (school_id, plan, max_buses, max_students, modules, valid_until, notes)
     select x.school_id, x.plan, x.max_buses, x.max_students, x.modules, school_local_date(x.school_id) + x.days, 'Demo subscription'
       from unnest($1::uuid[], $2::text[], $3::int[], $4::int[], $5::jsonb[], $6::int[]) as x(school_id, plan, max_buses, max_students, modules, days)
      where not exists (select 1 from school_subscriptions s where s.school_id = x.school_id and s.status = 'active')`,
    [
      S.map((s) => idOf.get(s.code)!),
      S.map((s) => s.subscription.plan),
      S.map((s) => s.subscription.maxBuses),
      S.map((s) => s.subscription.maxStudents),
      S.map((s) => JSON.stringify(s.subscription.modules)),
      S.map((s) => s.subscription.validForDays),
    ],
  );

  if (inserted.length) {
    await tx.query(
      `insert into audit_logs (school_id, actor_type, actor_name, action, entity_type, entity_id, new_values)
       select null, 'system', 'Demo seed', 'school.create', 'school', x.id, jsonb_build_object('code', x.code, 'source', 'seed')
         from unnest($1::uuid[], $2::text[]) as x(id, code)`,
      [inserted.map((s) => s.id), inserted.map((s) => s.code)],
    );
  }

  // Initial school admin of each school (inside that school's context, like the users module).
  for (const s of S) {
    await ctx.setContext({ schoolId: idOf.get(s.code)!, actorId: null, role: 'system' });
    await tx.query(
      `insert into users (school_id, role, full_name, email, phone, password_hash, must_change_password)
       values (nullif(current_setting('app.school_id', true), '')::uuid, 'school_admin', $1, $2, $3, $4, $5)
       on conflict do nothing`,
      [s.admin.name, s.admin.email, s.admin.phone, passwordHash, remoteTarget],
    );
  }

  await ctx.setContext({ schoolId: null, actorId: null, role: 'system' });
  logger.info({ schools: S.map((s) => s.code), created: inserted.map((s) => s.code), admins: S.map((s) => s.admin.email) }, 'Platform demo tenants seed applied');
}
