// Seed 01 · demo tenants (contract §14, first slice): two small schools in different states, each
// with one school admin, one driver and one conductor (app logins + staff profiles) and one
// student; one parent linked to a student in BOTH schools. The full demo dataset (buses, routes,
// trips…) is added by later module seeds. Idempotent: existing rows are left untouched.
// Demo password: SEED_DEFAULT_PASSWORD or Wimb@12345 (ctx.defaultPassword); driver PIN 1234.
import { hashPassword } from '../../shared/crypto.js';
import type { SeedContext } from '../seed.js';

export const DEMO_PIN = '1234';
export const DEMO_PARENT = { phone: '+919900000001', name: 'Vikram Mehta' } as const;

export const DEMO_SCHOOLS = [
  {
    code: 'GWIS-BLR',
    name: 'Greenwood International School',
    address: '14, 80 Feet Road, Koramangala 4th Block',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560034',
    latitude: 12.933756,
    longitude: 77.62275,
    brandColor: '#1B7F3B',
    contactName: 'Meera Iyer',
    contactPhone: '+918041234567',
    admin: { name: 'Meera Iyer', email: 'admin@greenwood.example', phone: '+919845000100' },
    driver: { name: 'Ravi Kumar', phone: '+919845000101', username: 'gwis.driver' },
    conductor: { name: 'Lakshmi Devi', phone: '+919845000102', username: 'gwis.conductor' },
    student: { name: 'Aarav Mehta', admissionNo: 'GW-1001', className: '5', section: 'A' },
  },
  {
    code: 'SUNRISE-JPR',
    name: 'Sunrise Public School',
    address: 'Plot 22, Malviya Nagar Sector 7',
    city: 'Jaipur',
    state: 'Rajasthan',
    pincode: '302017',
    latitude: 26.853722,
    longitude: 75.805208,
    brandColor: '#E8590C',
    contactName: 'Rajesh Sharma',
    contactPhone: '+911412345678',
    admin: { name: 'Rajesh Sharma', email: 'admin@sunrise.example', phone: '+919829000200' },
    driver: { name: 'Mahendra Singh', phone: '+919829000201', username: 'sps.driver' },
    conductor: { name: 'Pooja Rathore', phone: '+919829000202', username: 'sps.conductor' },
    student: { name: 'Isha Mehta', admissionNo: 'SP-2001', className: '3', section: 'B' },
  },
] as const;

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger, passwordHash, remoteTarget } = ctx;
  const pinHash = await hashPassword(DEMO_PIN);

  // Schools and their subscriptions are platform rows (super admin context under FORCE RLS).
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });
  await tx.query(
    `insert into schools (code, name, address, city, state, pincode, latitude, longitude, brand_color, contact_name, contact_phone, timezone)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::text[], $10::text[], $11::text[], $12::text[])
     on conflict (code) do nothing`,
    [
      DEMO_SCHOOLS.map((s) => s.code),
      DEMO_SCHOOLS.map((s) => s.name),
      DEMO_SCHOOLS.map((s) => s.address),
      DEMO_SCHOOLS.map((s) => s.city),
      DEMO_SCHOOLS.map((s) => s.state),
      DEMO_SCHOOLS.map((s) => s.pincode),
      DEMO_SCHOOLS.map((s) => s.latitude),
      DEMO_SCHOOLS.map((s) => s.longitude),
      DEMO_SCHOOLS.map((s) => s.brandColor),
      DEMO_SCHOOLS.map((s) => s.contactName),
      DEMO_SCHOOLS.map((s) => s.contactPhone),
      DEMO_SCHOOLS.map(() => 'Asia/Kolkata'),
    ],
  );
  const schools = await tx.many<{ id: string; code: string }>('select id, code from schools where code = any ($1)', [DEMO_SCHOOLS.map((s) => s.code)]);
  const idOf = new Map(schools.map((s) => [s.code, s.id]));
  await tx.query(
    `insert into school_subscriptions (school_id, plan, max_buses, max_students, modules)
     select s.id, 'standard', 50, 2000, '{"push": true}'::jsonb from schools s
      where s.id = any ($1::uuid[]) and not exists (select 1 from school_subscriptions x where x.school_id = s.id and x.status = 'active')`,
    [schools.map((s) => s.id)],
  );

  for (const s of DEMO_SCHOOLS) {
    const schoolId = idOf.get(s.code)!;
    await ctx.setContext({ schoolId, actorId: null, role: 'system' });
    await tx.query(
      `insert into users (school_id, role, full_name, email, phone, username, password_hash, pin_hash, must_change_password)
       values ($1, 'school_admin', $2, $3, $4, null, $5, null, $13),
              ($1, 'driver', $6, null, $7, $8, $5, $12, $13),
              ($1, 'conductor', $9, null, $10, $11, $5, null, $13)
       on conflict do nothing`,
      // remoteTarget (non-local database, --force only): demo logins must change the known password.
      [schoolId, s.admin.name, s.admin.email, s.admin.phone, passwordHash, s.driver.name, s.driver.phone, s.driver.username, s.conductor.name, s.conductor.phone, s.conductor.username, pinHash, remoteTarget],
    );
    await tx.query(
      `insert into staff_profiles (school_id, user_id, staff_type, full_name, phone, joining_date, experience_years, licence_no, licence_rto, licence_expiry_date)
       select u.school_id, u.id, u.role, u.full_name, u.phone, date '2023-06-01',
              case u.role when 'driver' then 9 else 4 end,
              case u.role when 'driver' then $2 end,
              case u.role when 'driver' then $3 end,
              case u.role when 'driver' then (school_local_date(u.school_id) + 540) end
         from users u
        where u.school_id = $1 and u.role in ('driver', 'conductor') and u.deleted_at is null
          and not exists (select 1 from staff_profiles sp where sp.user_id = u.id)`,
      [schoolId, s.code === 'GWIS-BLR' ? 'KA0120190012345' : 'RJ1420180054321', s.code === 'GWIS-BLR' ? 'KA-01 Bengaluru Central' : 'RJ-14 Jaipur'],
    );
    await tx.query(
      `insert into students (school_id, admission_no, full_name, class_name, section)
       values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [schoolId, s.student.admissionNo, s.student.name, s.student.className, s.student.section],
    );
    const parentId = (await tx.one<{ id: string }>('select ensure_parent_account($1, $2) as id', [DEMO_PARENT.phone, DEMO_PARENT.name])).id;
    await tx.query(
      `insert into school_parents (school_id, parent_account_id, full_name, relation) values ($1, $2, $3, 'father')
       on conflict (school_id, parent_account_id) do nothing`,
      [schoolId, parentId, DEMO_PARENT.name],
    );
    await tx.query(
      `insert into student_parents (school_id, student_id, parent_account_id, is_primary)
       select st.school_id, st.id, $2, true from students st
        where st.school_id = $1 and st.admission_no = $3 and st.deleted_at is null
       on conflict do nothing`,
      [schoolId, parentId, s.student.admissionNo],
    );
  }

  await ctx.setContext({ schoolId: null, actorId: null, role: 'system' });
  logger.info(
    { schools: DEMO_SCHOOLS.map((s) => s.code), admins: DEMO_SCHOOLS.map((s) => s.admin.email), parent: DEMO_PARENT.phone },
    'Demo tenants seed applied',
  );
}
