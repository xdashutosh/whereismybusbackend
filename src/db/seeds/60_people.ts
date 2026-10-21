// Seed 60 · people (contract §14; students module): per demo school 30–60 students (region-typical
// names, classes/sections or college programmes), their parents (school-specific fictional mobile
// series, siblings share parents, some e-mails) and per-direction bus → route → stop assignments.
// The demo parent Vikram Mehta (+919900000001, seed 01) stays the ONE parent linked to children in
// two schools (Greenwood and Sunrise); every other generated phone belongs to one school only.
// Assignments: students without an assignment for a direction are spread round-robin over the
// school's active routes of that direction that have a bus (open bus ↔ route assignment) and stops;
// the same route code serves both directions and the afternoon stop mirrors the morning one (drop
// routes run the stops in reverse). Stops within 150 m of the school are never used as a pick-up.
// Idempotent: students by admission number, parents by phone, links by pair, assignments only where
// missing (re-run after the routes seed to fill them). Schools that do not exist yet are skipped.
import type { SeedContext } from '../seed.js';
import { DEMO_PARENT } from './01_demo_tenants.js';

interface SchoolPeople {
  code: string;
  prefix: string;
  /** First generated admission number (seed 01 already created one student in two schools). */
  firstNo: number;
  count: number;
  /** 5-digit mobile series → +91<series><5 digits>. */
  series: string;
  first: readonly string[];
  surnames: readonly string[];
  /** College programmes instead of classes 1–10. */
  programmes?: readonly string[];
}

const MOTHERS = ['Lakshmi', 'Kavitha', 'Sunitha', 'Priya', 'Anitha', 'Deepa', 'Rekha', 'Swati', 'Meena', 'Geetha', 'Shobha', 'Asha'];
const FATHERS = ['Suresh', 'Ramesh', 'Mahesh', 'Rajesh', 'Prakash', 'Venkatesh', 'Anil', 'Sanjay', 'Vinod', 'Manoj', 'Kiran', 'Ashok'];

export const DEMO_PEOPLE: readonly SchoolPeople[] = [
  {
    code: 'GWIS-BLR', prefix: 'GW-', firstNo: 1002, count: 47, series: '98450',
    first: ['Aarav', 'Ananya', 'Vihaan', 'Diya', 'Advik', 'Ishita', 'Kabir', 'Navya', 'Reyansh', 'Saanvi', 'Arjun', 'Kavya', 'Rohan', 'Meghana', 'Pranav', 'Sneha', 'Tejas', 'Varsha', 'Nikhil', 'Shreya'],
    surnames: ['Rao', 'Gowda', 'Hegde', 'Shetty', 'Kulkarni', 'Bhat', 'Nayak', 'Murthy', 'Iyengar', 'Prasad'],
  },
  {
    code: 'SUNRISE-JPR', prefix: 'SP-', firstNo: 2002, count: 39, series: '98290',
    first: ['Aditya', 'Priya', 'Harsh', 'Kritika', 'Yash', 'Muskan', 'Dev', 'Tanvi', 'Laksh', 'Riya', 'Kunal', 'Nisha', 'Parth', 'Anjali', 'Vivaan', 'Khushi'],
    surnames: ['Sharma', 'Agarwal', 'Rathore', 'Shekhawat', 'Jain', 'Meena', 'Choudhary', 'Saini', 'Gupta', 'Joshi'],
  },
  {
    code: 'LAKEVIEW-HYD', prefix: 'LV-', firstNo: 3001, count: 36, series: '98490',
    first: ['Sai', 'Harini', 'Charan', 'Sravya', 'Rishi', 'Keerthi', 'Abhiram', 'Lasya', 'Vamsi', 'Pooja', 'Akhil', 'Divya', 'Karthik', 'Sahithi', 'Varun', 'Nandini'],
    surnames: ['Reddy', 'Goud', 'Naidu', 'Varma', 'Chary', 'Yadav', 'Sastry', 'Raju', 'Rao', 'Kumar'],
  },
  {
    code: 'RIVERSIDE-COK', prefix: 'RC-', firstNo: 4001, count: 32, series: '98470',
    first: ['Aditya', 'Anjali', 'Arun', 'Athira', 'Akhil', 'Gopika', 'Jithin', 'Lekshmi', 'Nithin', 'Parvathy', 'Rahul', 'Sreelakshmi', 'Vishnu', 'Devika', 'Abhijith', 'Neha'],
    surnames: ['Nair', 'Menon', 'Pillai', 'Kurian', 'Thomas', 'Varghese', 'Joseph', 'Panicker', 'Mathew', 'George'],
    programmes: ['B.Com 1', 'B.Com 2', 'BBA 1', 'B.Sc CS 2', 'BA English 3'],
  },
];

interface StudentSeed {
  admissionNo: string;
  fullName: string;
  className: string;
  section: string;
  rollNo: string;
}
interface ParentSeed {
  phone: string;
  fullName: string;
  relation: 'mother' | 'father' | 'guardian';
  email: string | null;
}
interface LinkSeed {
  admissionNo: string;
  phone: string;
  relation: string;
  primary: boolean;
}

/** Deterministic people of one school (same input → same rows, so re-runs change nothing). */
export function generatePeople(p: SchoolPeople): { students: StudentSeed[]; parents: ParentSeed[]; links: LinkSeed[] } {
  const students: StudentSeed[] = [];
  const parents = new Map<string, ParentSeed>();
  const links: LinkSeed[] = [];
  const rolls = new Map<string, number>();
  let family = -1;
  let familyParents: ParentSeed[] = [];
  let surname = '';
  for (let i = 0; i < p.count; i += 1) {
    const sibling = i % 6 === 5; // every sixth child is a younger sibling of the previous one
    if (!sibling) {
      family += 1;
      surname = p.surnames[(family * 7) % p.surnames.length]!;
      const phone = (k: number) => `+91${p.series}${String(20001 + family * 2 + k).padStart(5, '0')}`;
      const mother = MOTHERS[(family * 5) % MOTHERS.length]!;
      const father = FATHERS[(family * 3) % FATHERS.length]!;
      familyParents =
        family % 7 === 6
          ? [{ phone: phone(0), fullName: `${father} ${surname}`, relation: 'guardian', email: null }]
          : [
              { phone: phone(0), fullName: `${mother} ${surname}`, relation: 'mother', email: family % 3 === 0 ? `${mother}.${surname}${family}@example.com`.toLowerCase() : null },
              ...(family % 5 === 4 ? [] : [{ phone: phone(1), fullName: `${father} ${surname}`, relation: 'father' as const, email: null }]),
            ];
      for (const fp of familyParents) parents.set(fp.phone, fp);
    }
    const className = p.programmes ? p.programmes[i % p.programmes.length]! : String(1 + ((i * 7) % 10));
    const section = p.programmes ? 'A' : i % 3 === 2 ? 'B' : 'A';
    const key = `${className}|${section}`;
    rolls.set(key, (rolls.get(key) ?? 0) + 1);
    const admissionNo = `${p.prefix}${p.firstNo + i}`;
    students.push({ admissionNo, fullName: `${p.first[(i * 3 + family) % p.first.length]} ${surname}`, className, section, rollNo: String(rolls.get(key)) });
    familyParents.forEach((fp, k) => links.push({ admissionNo, phone: fp.phone, relation: fp.relation, primary: k === 0 }));
  }
  return { students, parents: [...parents.values()], links };
}

/** Round-robin assignment of unassigned students for one direction (see header). */
const ASSIGN_SQL = `
with today as (select school_local_date($1) as d),
svc as (
  select r.id as route_id, bra.bus_id, (row_number() over (order by r.code, r.id) - 1)::int as idx
    from routes r
    join lateral (select a.bus_id from bus_route_assignments a join buses b on b.id = a.bus_id and b.deleted_at is null and b.status <> 'retired'
                   where a.route_id = r.id and (a.valid_to is null or a.valid_to > now()) order by a.valid_from limit 1) bra on true
   where r.school_id = $1 and r.direction = $2 and r.deleted_at is null and r.is_active
     and exists (select 1 from stops s where s.route_id = r.id and s.deleted_at is null)),
n as (select count(*)::int as n from svc),
pickup as (
  select s.id as stop_id, s.route_id,
         (row_number() over (partition by s.route_id order by case when $2 = 'afternoon' then -s.sequence else s.sequence end) - 1)::int as idx,
         count(*) over (partition by s.route_id)::int as cnt
    from stops s cross join (select latitude, longitude from schools where id = $1) sc
   where s.deleted_at is null and s.route_id in (select route_id from svc)
     and (sc.latitude is null or not st_dwithin(s.geom, st_setsrid(st_makepoint(sc.longitude::float8, sc.latitude::float8), 4326)::geography, 150))),
todo as (
  select st.id, (row_number() over (order by st.admission_no, st.id) - 1)::int as idx,
         -- after any ended row of that direction (history never overlaps), else 90 days back
         greatest((select d from today) - 90,
                  coalesce((select max(a.valid_to) from student_assignments a where a.student_id = st.id and a.trip_direction = $2), (select d from today) - 90)) as start
    from students st
   where st.school_id = $1 and st.deleted_at is null and st.is_active
     and not exists (select 1 from student_assignments a where a.student_id = st.id and a.trip_direction = $2
                       and (a.valid_to is null or a.valid_to > (select d from today))))
insert into student_assignments (school_id, student_id, trip_direction, bus_id, route_id, stop_id, valid_from)
select $1, todo.id, $2, svc.bus_id, svc.route_id, p.stop_id, todo.start
  from todo cross join n
  join svc on n.n > 0 and svc.idx = todo.idx % n.n
  join pickup p on p.route_id = svc.route_id and p.idx = (todo.idx / n.n) % p.cnt`;

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger } = ctx;
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });
  const schools = await tx.many<{ id: string; code: string }>('select id, code from schools where code = any ($1) and deleted_at is null order by code', [DEMO_PEOPLE.map((p) => p.code)]);
  const summary: Record<string, { students: number; parents: number; links: number; morning: number; afternoon: number }> = {};

  for (const school of schools) {
    const people = generatePeople(DEMO_PEOPLE.find((p) => p.code === school.code)!);
    await ctx.setContext({ schoolId: school.id, actorId: null, role: 'system' });
    const s = people.students;
    const insertedStudents = await tx.query(
      `insert into students (school_id, admission_no, full_name, class_name, section, roll_no)
       select $1, x.a, x.n, x.c, x.s, x.r from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) as x(a, n, c, s, r)
       on conflict (school_id, admission_no) where deleted_at is null and admission_no is not null do nothing`,
      [school.id, s.map((x) => x.admissionNo), s.map((x) => x.fullName), s.map((x) => x.className), s.map((x) => x.section), s.map((x) => x.rollNo)],
    );
    const p = people.parents;
    const insertedParents = await tx.query(
      `insert into school_parents (school_id, parent_account_id, full_name, email, relation)
       select $1, ensure_parent_account(x.phone, x.name), x.name, x.email, x.relation
         from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as x(phone, name, email, relation)
       on conflict (school_id, parent_account_id) do nothing`,
      [school.id, p.map((x) => x.phone), p.map((x) => x.fullName), p.map((x) => x.email), p.map((x) => x.relation)],
    );
    const l = people.links;
    const insertedLinks = await tx.query(
      `insert into student_parents (school_id, student_id, parent_account_id, relation, is_primary)
       select $1, st.id, pa.id, x.relation, x.prim and not exists (select 1 from student_parents o where o.student_id = st.id and o.is_primary)
         from unnest($2::text[], $3::text[], $4::text[], $5::boolean[]) as x(adm, phone, relation, prim)
         join students st on st.school_id = $1 and st.admission_no = x.adm and st.deleted_at is null
         join parent_accounts pa on pa.phone = x.phone
       on conflict (student_id, parent_account_id) do nothing`,
      [school.id, l.map((x) => x.admissionNo), l.map((x) => x.phone), l.map((x) => x.relation), l.map((x) => x.primary)],
    );
    const morning = await tx.query(ASSIGN_SQL, [school.id, 'morning']);
    const afternoon = await tx.query(ASSIGN_SQL, [school.id, 'afternoon']);
    summary[school.code] = {
      students: insertedStudents.rowCount ?? 0,
      parents: insertedParents.rowCount ?? 0,
      links: insertedLinks.rowCount ?? 0,
      morning: morning.rowCount ?? 0,
      afternoon: afternoon.rowCount ?? 0,
    };
    const routes = await tx.one<{ n: number }>('select count(*)::int as n from routes where school_id = $1 and deleted_at is null', [school.id]);
    if (routes.n === 0) logger.warn({ school: school.code }, 'No routes yet: student assignments skipped (re-run the seed after the routes seed)');
  }

  await ctx.setContext({ schoolId: null, actorId: null, role: 'system' });
  logger.info({ summary, crossSchoolParent: DEMO_PARENT.phone }, 'People seed applied (inserted rows per school)');
}
