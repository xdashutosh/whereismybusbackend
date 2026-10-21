// Seed 40 · staff (contract §14): per demo school a full crew of drivers and conductors — profiles
// with joining date, experience, emergency contact, identity proof type + last 4 only, licence
// details (some licences expiring soon / expired, relative to the school-local date) — app logins
// (username + phone, demo password, drivers also PIN 1234), and documents (licence front/back,
// police verification, character certificate, first aid, training / child safety, identity —
// identity admin-only, some pending, some expiring). Staff created by seed 01 get the missing
// profile details and documents too. Active buses without any assignment history get a primary
// driver and a conductor (k-th staff member → k-th bus, like seed 30, which runs before the crew
// exists on a fresh database); R1 also gets the extra driver as backup driver.
// Idempotent: users by phone/username, profiles by login, documents by (staff, type[, title]);
// existing values are never overwritten. Document files are not seeded (they need stored objects).
import { hashPassword } from '../../shared/crypto.js';
import type { SeedContext } from '../seed.js';
import { DEMO_PIN } from './01_demo_tenants.js';

interface CrewMember {
  type: 'driver' | 'conductor';
  name: string;
  /** Last two digits of the phone within the school's block. */
  n: number;
  username: string;
}

interface SchoolCrew {
  code: string;
  phoneBlock: string;
  licencePrefix: string;
  rto: string;
  city: string;
  crew: CrewMember[];
  /** Staff created by seed 01 (enriched only). */
  existing: { type: 'driver' | 'conductor'; phone: string }[];
}

const d = (name: string, n: number, username: string): CrewMember => ({ type: 'driver', name, n, username });
const c = (name: string, n: number, username: string): CrewMember => ({ type: 'conductor', name, n, username });

export const STAFF_SEEDS: readonly SchoolCrew[] = [
  {
    code: 'GWIS-BLR', phoneBlock: '+9198450002', licencePrefix: 'KA01', rto: 'KA-01 Bengaluru Central', city: 'Bengaluru',
    existing: [{ type: 'driver', phone: '+919845000101' }, { type: 'conductor', phone: '+919845000102' }],
    crew: [
      d('Manjunath Gowda', 11, 'gwis.manjunath'), d('Shivakumar R', 12, 'gwis.shivakumar'), d('Prakash Hegde', 13, 'gwis.prakash'),
      d('Basavaraj Patil', 14, 'gwis.basavaraj'), d('Naveen Shetty', 15, 'gwis.naveen'),
      c('Kavitha S', 21, 'gwis.kavitha'), c('Shobha Naik', 22, 'gwis.shobha'), c('Roopa M', 23, 'gwis.roopa'), c('Geetha Rao', 24, 'gwis.geetha'),
    ],
  },
  {
    code: 'SUNRISE-JPR', phoneBlock: '+9198290002', licencePrefix: 'RJ14', rto: 'RJ-14 Jaipur', city: 'Jaipur',
    existing: [{ type: 'driver', phone: '+919829000201' }, { type: 'conductor', phone: '+919829000202' }],
    crew: [
      d('Ramesh Meena', 11, 'sps.ramesh'), d('Sanjay Sharma', 12, 'sps.sanjay'), d('Vikram Shekhawat', 13, 'sps.vikram'),
      d('Om Prakash Jat', 14, 'sps.omprakash'), d('Bhanwar Lal', 15, 'sps.bhanwar'),
      c('Sunita Choudhary', 21, 'sps.sunita'), c('Kamla Devi', 22, 'sps.kamla'), c('Rekha Saini', 23, 'sps.rekha'), c('Manju Gurjar', 24, 'sps.manju'),
    ],
  },
  {
    code: 'LAKEVIEW-HYD', phoneBlock: '+9198490003', licencePrefix: 'TS09', rto: 'TS-09 Khairatabad', city: 'Hyderabad', existing: [],
    crew: [
      d('Srinivas Reddy', 11, 'lva.srinivas'), d('Venkatesh Goud', 12, 'lva.venkatesh'), d('Mohammed Saleem', 13, 'lva.saleem'),
      d('Narsimha Rao', 14, 'lva.narsimha'), d('Raju Yadav', 15, 'lva.raju'), d('Anil Kumar Chary', 16, 'lva.anil'),
      c('Padma Latha', 21, 'lva.padma'), c('Saritha B', 22, 'lva.saritha'), c('Lakshmi Prasanna', 23, 'lva.prasanna'),
      c('Swapna K', 24, 'lva.swapna'), c('Farzana Begum', 25, 'lva.farzana'),
    ],
  },
  {
    code: 'RIVERSIDE-COK', phoneBlock: '+9194470004', licencePrefix: 'KL07', rto: 'KL-07 Ernakulam', city: 'Kochi', existing: [],
    crew: [
      d('Biju Thomas', 11, 'rsc.biju'), d('Suresh Nair', 12, 'rsc.suresh'), d('Anoop Kumar', 13, 'rsc.anoop'),
      d('Shaji Varghese', 14, 'rsc.shaji'), d('Rajesh Pillai', 15, 'rsc.rajesh'), d('Joseph Mathew', 16, 'rsc.joseph'),
      c('Sreeja Menon', 21, 'rsc.sreeja'), c('Bindu Joseph', 22, 'rsc.bindu'), c('Ambili Raj', 23, 'rsc.ambili'),
      c('Deepa Krishnan', 24, 'rsc.deepa'), c('Mini George', 25, 'rsc.mini'),
    ],
  },
];

/** Licence expiry, days from today, per driver index (some expiring soon, one expired). */
const LICENCE_EXPIRY = [540, 18, 900, -4, 1200, 700, 365];
const LOCALITIES: Record<string, string[]> = {
  Bengaluru: ['Koramangala', 'HSR Layout', 'BTM Layout', 'Jayanagar', 'Bellandur', 'Madiwala'],
  Jaipur: ['Malviya Nagar', 'Mansarovar', 'Jagatpura', 'Sanganer', 'Tonk Road', 'Vaishali Nagar'],
  Hyderabad: ['Somajiguda', 'Ameerpet', 'Begumpet', 'Panjagutta', 'Khairatabad', 'Banjara Hills'],
  Kochi: ['Kakkanad', 'Edappally', 'Vyttila', 'Palarivattom', 'Kaloor', 'Thrikkakara'],
};

export interface StaffSeedRow {
  type: 'driver' | 'conductor';
  name: string | null;
  phone: string;
  username: string | null;
  idx: number;
}

/** Profile details derived deterministically from the row (identity: last 4 only). */
export function profileDetails(s: SchoolCrew, r: StaffSeedRow) {
  const i = r.idx;
  // k spreads drivers and conductors apart (they share idx values).
  const k = i + (r.type === 'conductor' ? 7 : 0);
  const locality = LOCALITIES[s.city]![k % 6]!;
  return {
    address: `${12 + k * 7}, ${k % 2 ? 'Cross' : 'Main'} Road, ${locality}, ${s.city}`,
    joiningDate: `${2016 + (k % 8)}-${String((k % 12) + 1).padStart(2, '0')}-01`,
    experience: r.type === 'driver' ? 6 + ((i * 3) % 15) : 2 + (i % 9),
    summary: r.type === 'driver' ? `Heavy passenger vehicle licence; ${6 + ((i * 3) % 15)} years on school and city routes.` : 'Trained in student boarding, first aid and child safety.',
    emergencyName: `Family contact ${k + 1}`,
    emergencyPhone: `${s.phoneBlock}${String(60 + k).padStart(2, '0')}`,
    idType: k % 4 === 3 ? 'voter_id' : 'aadhaar',
    idLast4: String(4100 + k * 137).slice(-4),
    idVerified: k % 5 !== 4,
    licenceNo: r.type === 'driver' ? `${s.licencePrefix}${2008 + (i % 10)}00${String(31_000 + i * 977).slice(-5)}` : null,
    licenceExpiry: r.type === 'driver' ? LICENCE_EXPIRY[i % LICENCE_EXPIRY.length]! : null,
  };
}

interface DocSeed {
  phone: string;
  type: string;
  title: string | null;
  issuer: string | null;
  number: string | null;
  issue: number | null;
  expiry: number | null;
  verified: boolean;
}

const POLICE_EXPIRY = [165, 25, 400, 300, -10, 500, 240];
const FIRST_AID_EXPIRY = [300, 12, 200, 450, 90, 600, 380];

/** Documents per staff member; licence rows take their dates/number from the profile (null here). */
export function documentsFor(s: SchoolCrew, r: StaffSeedRow): DocSeed[] {
  const i = r.idx;
  const p = profileDetails(s, r);
  const base = { phone: r.phone, number: null, issue: null, expiry: null, verified: true };
  const docs: DocSeed[] = [
    { ...base, type: 'identity', title: p.idType === 'aadhaar' ? 'Aadhaar card' : 'Voter ID card', issuer: 'Government of India', number: p.idLast4, verified: p.idVerified },
    { ...base, type: 'police_verification', title: 'Police verification certificate', issuer: `${s.city} City Police`, number: `PV/${2025 - (i % 2)}/${1040 + i + (r.type === 'conductor' ? 50 : 0)}`, issue: POLICE_EXPIRY[i % 7]! - 730, expiry: POLICE_EXPIRY[i % 7]!, verified: i % 4 !== 2 },
    { ...base, type: 'character_certificate', title: 'Character certificate', issuer: 'Gazetted Officer', issue: -400 - i * 15 },
    { ...base, type: 'first_aid', title: 'First aid (St. John Ambulance)', issuer: 'St. John Ambulance India', issue: FIRST_AID_EXPIRY[i % 7]! - 1095, expiry: FIRST_AID_EXPIRY[i % 7]!, verified: i % 3 !== 1 },
  ];
  if (r.type === 'driver') {
    docs.push(
      { ...base, type: 'licence_front', title: 'Driving licence (front)', issuer: s.rto },
      { ...base, type: 'licence_back', title: 'Driving licence (back)', issuer: s.rto },
      { ...base, type: 'training', title: 'Defensive driving for school buses', issuer: 'State Road Safety Cell', issue: -200 - i * 20 },
    );
  } else {
    docs.push({ ...base, type: 'child_safety', title: 'Child safety and POCSO awareness', issuer: 'District Child Protection Unit', issue: -120 - i * 10, expiry: 245 + i * 30 });
  }
  return docs;
}

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger, passwordHash, remoteTarget } = ctx;
  const pinHash = await hashPassword(DEMO_PIN);
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });
  const schools = await tx.many<{ id: string; code: string }>('select id, code from schools where code = any ($1) and deleted_at is null order by code', [STAFF_SEEDS.map((x) => x.code)]);
  const summary: Record<string, { users: number; profiles: number; documents: number; assignments: number }> = {};

  for (const school of schools) {
    const s = STAFF_SEEDS.find((x) => x.code === school.code)!;
    await ctx.setContext({ schoolId: school.id, actorId: null, role: 'system' });
    const crew = s.crew.map((m) => ({ ...m, phone: `${s.phoneBlock}${String(m.n).padStart(2, '0')}` }));

    const users = await tx.query(
      `insert into users (school_id, role, full_name, phone, username, password_hash, pin_hash, must_change_password)
       select $1, x.role, x.name, x.phone, x.username, $6, case when x.role = 'driver' then $7 end, $8
         from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as x(role, name, phone, username)
       on conflict do nothing`,
      [school.id, crew.map((m) => m.type), crew.map((m) => m.name), crew.map((m) => m.phone), crew.map((m) => m.username), passwordHash, pinHash, remoteTarget],
    );

    // Index per staff type (seed-01 staff first) drives the derived details.
    const rows: StaffSeedRow[] = [];
    for (const type of ['driver', 'conductor'] as const) {
      const ofType = [...s.existing.filter((e) => e.type === type).map((e) => ({ type, name: null, phone: e.phone, username: null })),
        ...crew.filter((m) => m.type === type).map((m) => ({ type, name: m.name, phone: m.phone, username: m.username }))];
      ofType.forEach((r, idx) => rows.push({ ...r, idx }));
    }
    const det = rows.map((r) => profileDetails(s, r));
    const cols = [
      rows.map((r) => r.phone), det.map((x) => x.address), det.map((x) => x.joiningDate), det.map((x) => x.experience), det.map((x) => x.summary),
      det.map((x) => x.emergencyName), det.map((x) => x.emergencyPhone), det.map((x) => x.idType), det.map((x) => x.idLast4),
      det.map((x) => (x.idVerified ? 'verified' : 'pending')), det.map((x) => x.licenceNo), det.map((x) => x.licenceExpiry),
    ];
    const X = `unnest($2::text[], $3::text[], $4::date[], $5::numeric[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::int[])
      as x(phone, address, joining, experience, summary, e_name, e_phone, id_type, id_last4, id_status, licence_no, licence_offset)`;
    const profiles = await tx.query(
      `insert into staff_profiles (school_id, user_id, staff_type, full_name, phone, address, joining_date, experience_years, experience_summary,
                                   emergency_contact_name, emergency_contact_phone, id_proof_type, id_proof_last4, id_verification_status,
                                   licence_no, licence_rto, licence_issue_date, licence_expiry_date, licence_verification_status)
       select $1, u.id, u.role, u.full_name, u.phone, x.address, x.joining, x.experience, x.summary, x.e_name, x.e_phone, x.id_type, x.id_last4, x.id_status,
              x.licence_no, case when u.role = 'driver' then $14 end,
              case when u.role = 'driver' then (select app_local_date()) + x.licence_offset - 7300 end,
              case when u.role = 'driver' then (select app_local_date()) + x.licence_offset end,
              case when u.role = 'driver' then (case when x.licence_offset > 0 then 'verified' else 'pending' end) else 'pending' end
         from ${X}
         join users u on u.school_id = $1 and u.phone = x.phone and u.role in ('driver', 'conductor') and u.deleted_at is null
        where not exists (select 1 from staff_profiles sp where sp.user_id = u.id)`,
      [school.id, ...cols, s.rto],
    );
    // Seed-01 staff (and any profile with gaps): fill missing details only.
    await tx.query(
      `update staff_profiles sp set
          address = coalesce(sp.address, x.address), joining_date = coalesce(sp.joining_date, x.joining),
          experience_years = coalesce(sp.experience_years, x.experience), experience_summary = coalesce(sp.experience_summary, x.summary),
          emergency_contact_name = coalesce(sp.emergency_contact_name, x.e_name), emergency_contact_phone = coalesce(sp.emergency_contact_phone, x.e_phone),
          id_proof_type = coalesce(sp.id_proof_type, x.id_type), id_proof_last4 = coalesce(sp.id_proof_last4, x.id_last4),
          licence_rto = case when sp.staff_type = 'driver' then coalesce(sp.licence_rto, $14) end,
          licence_issue_date = case when sp.staff_type = 'driver' then coalesce(sp.licence_issue_date, least(sp.licence_expiry_date, (select app_local_date())) - 7300) end
         from ${X}
        where sp.school_id = $1 and sp.phone = x.phone and sp.deleted_at is null and sp.id_proof_last4 is null`,
      [school.id, ...cols, s.rto],
    );

    // Documents: one current row per (staff, type) — training by title — unless one exists.
    const docs = rows.flatMap((r) => documentsFor(s, r));
    const documents = await tx.query(
      `insert into staff_documents (school_id, staff_id, doc_type, title, issuer, doc_number, issue_date, expiry_date,
                                    verification_status, verified_at, visible_to_parents_status, visible_to_parents_file)
       select $1, sp.id, x.doc_type, x.title, x.issuer,
              case when x.doc_type like 'licence%' then sp.licence_no else x.doc_number end,
              case when x.doc_type like 'licence%' then sp.licence_issue_date else (select app_local_date()) + x.issue_offset end,
              case when x.doc_type like 'licence%' then sp.licence_expiry_date else (select app_local_date()) + x.expiry_offset end,
              case when x.verified then 'verified' else 'pending' end, case when x.verified then now() end,
              x.doc_type <> 'identity', false
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::boolean[])
              as x(phone, doc_type, title, issuer, doc_number, issue_offset, expiry_offset, verified)
         join staff_profiles sp on sp.school_id = $1 and sp.phone = x.phone and sp.deleted_at is null
        where not exists (select 1 from staff_documents d where d.staff_id = sp.id and d.doc_type = x.doc_type and d.is_current and d.deleted_at is null
                            and (x.doc_type not in ('training', 'other') or d.title is not distinct from x.title))`,
      [
        school.id,
        docs.map((x) => x.phone), docs.map((x) => x.type), docs.map((x) => x.title), docs.map((x) => x.issuer), docs.map((x) => x.number),
        docs.map((x) => x.issue), docs.map((x) => x.expiry), docs.map((x) => x.verified),
      ],
    );

    // Bus assignments: k-th unassigned driver/conductor → k-th active bus without any history
    // (same rule as seed 30), then the next free driver becomes backup driver of R1.
    const primary = await tx.query(
      `with fleet as (
         select b.id, row_number() over (order by b.code) as n from buses b
          where b.school_id = $1 and b.deleted_at is null and b.status = 'active'
            and not exists (select 1 from bus_staff_assignments a where a.bus_id = b.id)
       ), staff as (
         select sp.id, sp.staff_type, row_number() over (partition by sp.staff_type order by sp.created_at, sp.full_name, sp.id) as n
           from staff_profiles sp where sp.school_id = $1 and sp.deleted_at is null and sp.is_active
            and not exists (select 1 from bus_staff_assignments a where a.staff_id = sp.id and (a.valid_to is null or a.valid_to > now()))
       )
       insert into bus_staff_assignments (school_id, bus_id, staff_id, assignment_role, valid_from)
       select $1, f.id, s.id, case s.staff_type when 'driver' then 'primary_driver' else 'conductor' end, now() - interval '30 days'
         from fleet f join staff s on s.n = f.n`,
      [school.id],
    );
    const backup = await tx.query(
      `insert into bus_staff_assignments (school_id, bus_id, staff_id, assignment_role, valid_from)
       select $1, b.id, sp.id, 'backup_driver', now() - interval '30 days'
         from buses b
         cross join lateral (
           select sp.id from staff_profiles sp
            where sp.school_id = $1 and sp.staff_type = 'driver' and sp.deleted_at is null and sp.is_active
              and not exists (select 1 from bus_staff_assignments a where a.staff_id = sp.id and (a.valid_to is null or a.valid_to > now()))
            order by sp.created_at, sp.full_name, sp.id limit 1
         ) sp
        where b.school_id = $1 and b.code = 'R1' and b.deleted_at is null and b.status = 'active'
          and not exists (select 1 from bus_staff_assignments a where a.bus_id = b.id and a.assignment_role = 'backup_driver')`,
      [school.id],
    );
    summary[school.code] = {
      users: users.rowCount ?? 0,
      profiles: profiles.rowCount ?? 0,
      documents: documents.rowCount ?? 0,
      assignments: (primary.rowCount ?? 0) + (backup.rowCount ?? 0),
    };
  }

  await ctx.setContext({ schoolId: null, actorId: null, role: 'system' });
  logger.info({ staff: summary }, 'Staff seed applied');
}
