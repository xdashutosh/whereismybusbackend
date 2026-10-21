// Seed 30 · buses (contract §14): per demo school a fleet R1…R6 with state-appropriate
// registrations, bus documents (insurance, fitness, pollution, permit — some expired or expiring
// soon, relative to the school-local date) and staff assignments (the school's drivers and
// conductors become primary driver / conductor of the first buses, in creation order).
// Idempotent: existing buses (by code), current documents (by type) and buses that already have
// staff assignments are left untouched. Schools that do not exist yet are skipped. Bus images
// are not seeded (they need stored objects; upload them in the admin panel).
import type { SeedContext } from '../seed.js';

interface SeedBus {
  code: string;
  name: string;
  type: 'bus' | 'mini_bus' | 'van';
  makeModel: string;
  year: number;
  color: string;
  capacity: number;
  plate: string;
  fuel: 'diesel' | 'cng' | 'electric';
  status: 'active' | 'maintenance';
  odometer: number;
}

/** Days from today (school-local) to the expiry of [insurance, fitness, pollution, permit] per bus index. */
const EXPIRY_OFFSETS: readonly (readonly [number, number, number, number])[] = [
  [240, 300, 120, 330],
  [12, 280, 90, 300], // insurance expiring soon
  [200, -5, 60, 280], // fitness expired
  [310, 150, 25, 260], // pollution expiring soon
  [180, 220, 140, 200],
  [270, 190, -12, 350], // pollution expired (bus in maintenance)
];

function fleet(prefix: string, series: string[], make: (i: number) => string): SeedBus[] {
  const base: Omit<SeedBus, 'plate' | 'makeModel'>[] = [
    { code: 'R1', name: 'Route 1 Bus', type: 'bus', year: 2021, color: 'Yellow', capacity: 40, fuel: 'diesel', status: 'active', odometer: 48210.4 },
    { code: 'R2', name: 'Route 2 Bus', type: 'bus', year: 2020, color: 'Yellow', capacity: 40, fuel: 'diesel', status: 'active', odometer: 61877.0 },
    { code: 'R3', name: 'Route 3 Bus', type: 'bus', year: 2022, color: 'Yellow', capacity: 32, fuel: 'cng', status: 'active', odometer: 30544.8 },
    { code: 'R4', name: 'Mini Bus 4', type: 'mini_bus', year: 2023, color: 'White', capacity: 26, fuel: 'diesel', status: 'active', odometer: 18320.2 },
    { code: 'R5', name: 'Green Van', type: 'van', year: 2024, color: 'Green', capacity: 14, fuel: 'electric', status: 'active', odometer: 9120.0 },
    { code: 'R6', name: 'Route 6 Bus', type: 'bus', year: 2018, color: 'Yellow', capacity: 45, fuel: 'diesel', status: 'maintenance', odometer: 104355.6 },
  ];
  return base.map((b, i) => ({ ...b, makeModel: make(i), plate: `${prefix}${series[i % series.length]}${String(1201 + i * 1117).slice(-4)}` }));
}

const MAKES = ['Tata Starbus Ultra', 'Ashok Leyland Lynx', 'Eicher Skyline Pro', 'Force Traveller', 'Tata Winger EV', 'Ashok Leyland Sunshine'];
const make = (i: number) => MAKES[i % MAKES.length]!;

/** Demo fleets by school code (contract §14 tenants; plates follow each state's RTO series). */
export const DEMO_FLEETS: Readonly<Record<string, SeedBus[]>> = {
  'GWIS-BLR': fleet('KA01', ['AB', 'AC', 'AD', 'MF', 'EV', 'AE'], make),
  'SUNRISE-JPR': fleet('RJ14', ['PA', 'PB', 'PC', 'PD', 'EV', 'PE'], make),
  'LAKEVIEW-HYD': fleet('TS09', ['EA', 'EB', 'EC', 'ED', 'EV', 'EE'], make),
  'RIVERSIDE-COK': fleet('KL07', ['BD', 'BE', 'BF', 'BG', 'EV', 'BH'], make),
};

const DOC_TYPES = ['insurance', 'fitness', 'pollution', 'permit'] as const;
const ISSUERS: Record<(typeof DOC_TYPES)[number], string> = {
  insurance: 'New India Assurance',
  fitness: 'Regional Transport Office',
  pollution: 'Authorised PUC Centre',
  permit: 'State Transport Authority',
};

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger } = ctx;
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });
  const schools = await tx.many<{ id: string; code: string }>('select id, code from schools where code = any ($1) and deleted_at is null order by code', [Object.keys(DEMO_FLEETS)]);
  const summary: Record<string, number> = {};

  for (const school of schools) {
    const buses = DEMO_FLEETS[school.code]!;
    await ctx.setContext({ schoolId: school.id, actorId: null, role: 'system' });
    const inserted = await tx.query(
      `insert into buses (school_id, code, display_name, vehicle_type, make_model, manufacture_year, color, capacity, registration_no,
                          fuel_type, status, last_known_odometer, odometer_updated_at)
       select $1, x.code, x.name, x.type, x.make_model, x.year, x.color, x.capacity, x.plate, x.fuel, x.status, x.odometer, now()
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::int[], $9::text[], $10::text[], $11::text[], $12::numeric[])
              as x(code, name, type, make_model, year, color, capacity, plate, fuel, status, odometer)
       on conflict (school_id, code) where deleted_at is null do nothing`,
      [
        school.id,
        buses.map((b) => b.code),
        buses.map((b) => b.name),
        buses.map((b) => b.type),
        buses.map((b) => b.makeModel),
        buses.map((b) => b.year),
        buses.map((b) => b.color),
        buses.map((b) => b.capacity),
        buses.map((b) => b.plate),
        buses.map((b) => b.fuel),
        buses.map((b) => b.status),
        buses.map((b) => b.odometer),
      ],
    );
    summary[school.code] = inserted.rowCount ?? 0;

    // Documents: one current row per (bus, type) unless one exists; number derived from the plate.
    const rows = buses.flatMap((b, i) => DOC_TYPES.map((type, j) => ({ code: b.code, type, offset: EXPIRY_OFFSETS[i % EXPIRY_OFFSETS.length]![j]! })));
    await tx.query(
      `insert into bus_documents (school_id, bus_id, doc_type, title, issuer, doc_number, start_date, expiry_date,
                                  verification_status, verified_at, visible_to_parents_status, visible_to_parents_file)
       select b.school_id, b.id, x.doc_type, initcap(replace(x.doc_type, '_', ' ')) || ' certificate', x.issuer,
              upper(left(x.doc_type, 3)) || '-' || b.registration_no,
              (select app_local_date()) + x.offset_days - 365, (select app_local_date()) + x.offset_days,
              case when x.offset_days > 0 then 'verified' else 'pending' end,
              case when x.offset_days > 0 then now() end,
              true, false
         from unnest($2::text[], $3::text[], $4::text[], $5::int[]) as x(code, doc_type, issuer, offset_days)
         join buses b on b.school_id = $1 and b.code = x.code and b.deleted_at is null
        where not exists (select 1 from bus_documents d where d.bus_id = b.id and d.doc_type = x.doc_type and d.is_current and d.deleted_at is null)`,
      [school.id, rows.map((r) => r.code), rows.map((r) => r.type), rows.map((r) => ISSUERS[r.type]), rows.map((r) => r.offset)],
    );

    // Staff: k-th driver → primary driver of the k-th bus, k-th conductor → its conductor
    // (only buses without any assignment history, so re-runs and admin changes are kept).
    await tx.query(
      `with fleet as (
         select b.id, row_number() over (order by b.code) as n from buses b
          where b.school_id = $1 and b.deleted_at is null and b.status = 'active'
            and not exists (select 1 from bus_staff_assignments a where a.bus_id = b.id)
       ), staff as (
         select sp.id, sp.staff_type, row_number() over (partition by sp.staff_type order by sp.created_at, sp.id) as n
           from staff_profiles sp where sp.school_id = $1 and sp.deleted_at is null and sp.is_active
            and not exists (select 1 from bus_staff_assignments a where a.staff_id = sp.id and a.valid_to is null)
       )
       insert into bus_staff_assignments (school_id, bus_id, staff_id, assignment_role, valid_from)
       select $1, f.id, s.id, case s.staff_type when 'driver' then 'primary_driver' else 'conductor' end, now() - interval '30 days'
         from fleet f join staff s on s.n = f.n`,
      [school.id],
    );
  }

  await ctx.setContext({ schoolId: null, actorId: null, role: 'system' });
  logger.info({ busesInserted: summary }, 'Buses seed applied');
}
