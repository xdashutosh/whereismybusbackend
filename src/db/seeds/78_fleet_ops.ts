// Seed 78 · fleet operations (contract §14, BP §13.3 Fuel / Maintenance): per demo school about five
// months of fuel logs and a year of maintenance history for buses R1–R6, so the fuel list, the per-bus
// mileage trend, the maintenance log, the service due list and the reports are populated.
//   · fuel: fills every few days at city stations (diesel / CNG in kg / depot charging in kWh for the
//     electric van) with realistic mileage bands and city fuel prices; readings are continuous and end
//     below the first seeded trip reading of seed 70 (or the bus's last known odometer), so the
//     odometer checks stay quiet except for ONE deliberate typo per school (bus R4, a reading 900 km too
//     low — it and the fill before it show odometer flags); R2 has one fill without a reading.
//   · maintenance: general service, oil change, brakes, tyres, fire extinguisher, CNG kit / cylinder,
//     EV battery checks with next due date / km; the latest service of each kind gives a due list with
//     every state: R1 general service due soon (date), R2 oil change overdue (date) and tyre rotation due
//     soon (km), R3 CNG kit service overdue, R5 battery check due soon, R6 (in the workshop) general
//     service overdue by km and a clutch overhaul in progress; the rest is scheduled.
//   · the latest fill and the latest paid service of each bus carry a generated PDF bill / invoice
//     (stored through the storage driver, like seed 70's odometer photos).
// Idempotent: a bus that already has fuel logs (maintenance logs) gets no new fuel (maintenance) rows.
// Runs before 80_alerts, whose real maintenance-due-scan then raises the service_due alerts of these logs.
import crypto from 'node:crypto';
import { renderPdf } from '../../shared/pdf.js';
import { storage } from '../../shared/storage.js';
import type { SeedContext } from '../seed.js';
import type { Tx } from '../tenant.js';
import { DEMO_FLEETS } from './30_buses.js';

interface CityProfile {
  diesel: number;
  cng: number;
  kwh: number;
  stations: readonly string[];
  workshops: readonly string[];
  authorised: string;
}

/** Prices per litre / kg / kWh (INR) and local suppliers by school code. */
const CITY: Readonly<Record<string, CityProfile>> = {
  'GWIS-BLR': {
    diesel: 88.9, cng: 89.0, kwh: 11.5,
    stations: ['Indian Oil, Hosur Road', 'HP, Bannerghatta Road', 'Bharat Petroleum, Outer Ring Road, HSR Layout'],
    workshops: ['Sri Ganesh Motors, HSR Layout', 'Bommanahalli Auto Works', 'Fleet Care Tyres, Silk Board'],
    authorised: 'Prerana Motors (authorised service), Bommasandra',
  },
  'SUNRISE-JPR': {
    diesel: 90.4, cng: 84.5, kwh: 9.5,
    stations: ['Indian Oil, Tonk Road', 'HP, JLN Marg', 'Bharat Petroleum, Ajmer Road'],
    workshops: ['Shree Balaji Motor Garage, Sanganer', 'Malviya Nagar Auto Clinic', 'Rajasthan Tyre House, Sindhi Camp'],
    authorised: 'Jaipur Commercial Vehicles (authorised service), VKI Area',
  },
  'LAKEVIEW-HYD': {
    diesel: 95.7, cng: 96.0, kwh: 10.0,
    stations: ['Indian Oil, Gachibowli', 'HP, Madhapur', 'Bharat Petroleum, Kondapur'],
    workshops: ['Sai Krishna Motors, Kukatpally', 'Hitech City Auto Service', 'Deccan Tyres, Miyapur'],
    authorised: 'Telangana Bus Body & Service (authorised), Patancheru',
  },
  'RIVERSIDE-COK': {
    diesel: 95.6, cng: 89.0, kwh: 10.5,
    stations: ['Indian Oil, Edappally', 'HP, Vyttila', 'Bharat Petroleum, Kakkanad'],
    workshops: ['Kerala Motor Works, Palarivattom', 'St. Joseph Auto Garage, Kaloor', 'Malabar Tyres, Vyttila'],
    authorised: 'Popular Commercial Vehicles (authorised service), Kalamassery',
  },
};

/** Per bus code: km driven per school day, fill interval (days), mileage band (km per litre / kg / kWh). */
const DRIVING: Readonly<Record<string, { dailyKm: number; interval: number; kmpl: [number, number] }>> = {
  R1: { dailyKm: 92, interval: 6, kmpl: [5.6, 6.4] },
  R2: { dailyKm: 104, interval: 6, kmpl: [5.4, 6.2] },
  R3: { dailyKm: 86, interval: 3, kmpl: [3.6, 4.2] },
  R4: { dailyKm: 74, interval: 7, kmpl: [8.6, 10.0] },
  R5: { dailyKm: 58, interval: 7, kmpl: [5.6, 6.6] },
  R6: { dailyKm: 110, interval: 6, kmpl: [5.0, 5.8] },
};

export const FUEL_HISTORY_DAYS = 150;
const MAINTENANCE_HISTORY_DAYS = 365;

/** Deterministic PRNG per school + bus (mulberry32 over a SHA-256 seed). */
export function rng(seed: string): () => number {
  let a = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isSunday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() === 0;
const epochDay = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
/** School days (Mon–Sat) in (from, to] — constant time (epoch day 0 was a Thursday). */
export function drivingDays(from: string, to: string): number {
  const f = epochDay(from);
  const t = epochDay(to);
  if (t <= f) return 0;
  const sundays = Math.floor((t + 4) / 7) - Math.floor((f + 4) / 7);
  return t - f - sundays;
}

export interface Fill {
  day: string;
  /** True reading (continuous series). */
  reading: number;
  /** Reading as entered (null = not written down; differs from `reading` for the deliberate typo). */
  entered: number | null;
  litres: number;
  cost: number;
  station: string;
  notes: string | null;
}

/**
 * Fills of one bus, oldest first: the last fill is on `lastDay` with a reading below `anchorReading`
 * (the first reading seed 70 recorded on `anchorDay`, or the bus odometer).
 */
export function fuelSeries(o: { schoolCode: string; busCode: string; fuelType: string; anchorDay: string; anchorReading: number; lastDay: string; fromDay: string }): Fill[] {
  const drive = DRIVING[o.busCode]!;
  const city = CITY[o.schoolCode]!;
  const rand = rng(`${o.schoolCode}:${o.busCode}:fuel`);
  const days: string[] = [];
  for (let d = o.lastDay; d >= o.fromDay; ) {
    days.push(isSunday(d) ? addDays(d, -1) : d);
    d = addDays(d, -(drive.interval + (rand() < 0.3 ? 1 : 0)));
  }
  days.reverse();
  const readings = new Array<number>(days.length);
  readings[days.length - 1] = round(o.anchorReading - drive.dailyKm * Math.max(1, drivingDays(o.lastDay, o.anchorDay)) - 6.4, 1);
  for (let i = days.length - 2; i >= 0; i -= 1) {
    readings[i] = round(readings[i + 1]! - drive.dailyKm * drivingDays(days[i]!, days[i + 1]!) * (0.92 + rand() * 0.16), 1);
  }
  const price = o.fuelType === 'electric' ? city.kwh : o.fuelType === 'cng' ? city.cng : city.diesel;
  return days.map((day, i) => {
    const distance = i === 0 ? drive.dailyKm * drive.interval : readings[i]! - readings[i - 1]!;
    const kmpl = drive.kmpl[0] + rand() * (drive.kmpl[1] - drive.kmpl[0]);
    const litres = round(distance / kmpl);
    const drift = 1 - 0.015 * (1 - i / Math.max(1, days.length - 1)); // prices crept up ~1.5 % over the months
    const station = o.fuelType === 'electric' ? 'School depot charger' : city.stations[Math.floor(rand() * city.stations.length)]!;
    let entered: number | null = readings[i]!;
    let notes: string | null = i === days.length - 1 ? 'Full tank before the week' : null;
    if (o.busCode === 'R4' && i === days.length - 5) {
      entered = round(readings[i]! - 900, 1);
      notes = 'Reading as written on the bill';
    }
    if (o.busCode === 'R2' && i === days.length - 7) {
      entered = null;
      notes = 'Driver did not note the odometer';
    }
    return { day, reading: readings[i]!, entered, litres, cost: round(litres * price * drift), station, notes };
  });
}

/** Reading of the continuous series on `day` (linear between fills, extrapolated outside). */
export function readingOn(fills: readonly Fill[], day: string, dailyKm: number): number {
  const first = fills[0]!;
  const last = fills[fills.length - 1]!;
  if (day <= first.day) return round(Math.max(0, first.reading - dailyKm * drivingDays(day, first.day)), 1);
  if (day >= last.day) return round(last.reading + dailyKm * drivingDays(last.day, day), 1);
  for (let i = 1; i < fills.length; i += 1) {
    const a = fills[i - 1]!;
    const b = fills[i]!;
    if (day <= b.day) {
      const span = Math.max(1, drivingDays(a.day, b.day));
      return round(a.reading + ((b.reading - a.reading) * drivingDays(a.day, day)) / span, 1);
    }
  }
  return last.reading;
}

/** Latest day whose series reading is ≤ `reading` (for km-based services; the series never decreases). */
export function dayAtReading(fills: readonly Fill[], reading: number, dailyKm: number, today: string): string {
  const max = MAINTENANCE_HISTORY_DAYS * 2;
  if (readingOn(fills, today, dailyKm) <= reading) return today;
  if (readingOn(fills, addDays(today, -max), dailyKm) > reading) return addDays(today, -max);
  // Invariant: reading(today - lo) > reading ≥ reading(today - hi).
  let lo = 0;
  let hi = max;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (readingOn(fills, addDays(today, -mid), dailyKm) <= reading) hi = mid;
    else lo = mid;
  }
  return addDays(today, -hi);
}

interface ServiceSpec {
  type: string;
  everyDays: number | null;
  everyKm: number | null;
  cost: readonly [number, number];
  authorised: boolean;
  notes: readonly string[];
}

const SERVICES = {
  general: { type: 'General service', everyDays: 90, everyKm: 10000, cost: [8500, 14000], authorised: true, notes: ['Engine oil, oil / fuel / air filters, greasing', 'Periodic service, wipers replaced', 'Periodic service, coolant topped up'] },
  evGeneral: { type: 'General service', everyDays: 180, everyKm: null, cost: [3000, 4500], authorised: true, notes: ['Periodic EV service, cabin filter, brake fluid'] },
  oil: { type: 'Oil change', everyDays: 60, everyKm: 6000, cost: [4200, 6500], authorised: false, notes: ['Engine oil 15W-40 and oil filter', 'Engine oil and filter, no leaks found'] },
  brake: { type: 'Brake inspection', everyDays: 120, everyKm: null, cost: [1800, 3500], authorised: false, notes: ['Front pads replaced, drums cleaned', 'Brake fluid topped up, pads at 60 %', 'Rear shoes adjusted'] },
  tyre: { type: 'Tyre rotation', everyDays: null, everyKm: 10000, cost: [1200, 2000], authorised: false, notes: ['Rotated and balanced all tyres'] },
  fire: { type: 'Fire extinguisher refill', everyDays: 365, everyKm: null, cost: [900, 1400], authorised: false, notes: ['2 kg ABC extinguisher refilled and tagged'] },
  governor: { type: 'Speed governor calibration', everyDays: 365, everyKm: null, cost: [1500, 1500], authorised: true, notes: ['Calibrated to 40 km/h, certificate issued'] },
  cngKit: { type: 'CNG kit service', everyDays: 90, everyKm: null, cost: [3500, 5000], authorised: false, notes: ['Pressure regulator and filter serviced, leak test passed'] },
  cngCylinder: { type: 'CNG cylinder inspection', everyDays: 365, everyKm: null, cost: [6500, 6500], authorised: false, notes: ['Hydro test passed, valid for one year'] },
  battery: { type: 'Battery health check', everyDays: 180, everyKm: null, cost: [1500, 1500], authorised: true, notes: ['State of health 94 %, cell balancing done'] },
  clutch: { type: 'Clutch overhaul', everyDays: null, everyKm: null, cost: [18500, 24000], authorised: true, notes: ['Clutch plate and pressure plate replaced (in the workshop)'] },
} as const satisfies Record<string, ServiceSpec>;
type ServiceKey = keyof typeof SERVICES;

/** Latest service per kind: days ago, or km left to the next due reading (km-only, from the bus odometer). */
type Last = { ago: number } | { kmToDue: number };
// R5's battery check (due in 2–3 days) always sorts before R1's general service (due in 4–5 days): the
// Sunday shift below moves a service one day earlier, so equal or adjacent due dates would flip by weekday.
const PLANS: Readonly<Record<string, readonly (readonly [ServiceKey, Last])[]>> = {
  R1: [['general', { ago: 85 }], ['oil', { ago: 20 }], ['brake', { ago: 50 }], ['fire', { ago: 200 }], ['governor', { ago: 300 }]],
  R2: [['general', { ago: 40 }], ['oil', { ago: 64 }], ['brake', { ago: 30 }], ['tyre', { kmToDue: 300 }], ['fire', { ago: 150 }]],
  R3: [['general', { ago: 30 }], ['cngKit', { ago: 92 }], ['cngCylinder', { ago: 300 }], ['brake', { ago: 70 }]],
  R4: [['general', { ago: 60 }], ['oil', { ago: 10 }], ['brake', { ago: 100 }], ['fire', { ago: 250 }]],
  R5: [['evGeneral', { ago: 120 }], ['battery', { ago: 177 }], ['brake', { ago: 40 }], ['tyre', { kmToDue: 4200 }]],
  R6: [['general', { kmToDue: -400 }], ['clutch', { ago: 12 }], ['brake', { ago: 110 }], ['fire', { ago: 330 }]],
};

export interface ServiceRow {
  type: string;
  day: string;
  cost: number;
  odometer: number | null;
  vendor: string;
  notes: string;
  nextDueDate: string | null;
  nextDueKm: number | null;
  latest: boolean;
}

/** Maintenance history of one bus, oldest first (entries after the last fill carry no reading). */
export function maintenanceSeries(o: { schoolCode: string; busCode: string; fills: readonly Fill[]; busOdometer: number; today: string }): ServiceRow[] {
  const drive = DRIVING[o.busCode]!;
  const city = CITY[o.schoolCode]!;
  const rand = rng(`${o.schoolCode}:${o.busCode}:maintenance`);
  const lastFill = o.fills[o.fills.length - 1]!.day;
  const from = addDays(o.today, -MAINTENANCE_HISTORY_DAYS);
  const out: ServiceRow[] = [];
  for (const [key, last] of PLANS[o.busCode] ?? []) {
    const spec: ServiceSpec = SERVICES[key];
    // workshops: [0, 1] general garages, [2] the tyre shop.
    const vendor = spec.authorised ? city.authorised : key === 'tyre' ? city.workshops[2]! : city.workshops[rand() < 0.5 ? 0 : 1]!;
    const entries: { day: string; odometer: number | null }[] = [];
    if ('kmToDue' in last) {
      for (let target = o.busOdometer + last.kmToDue - spec.everyKm!; target > 0; target -= spec.everyKm!) {
        const day = dayAtReading(o.fills, target, drive.dailyKm, o.today);
        if (day < from) break;
        entries.push({ day, odometer: round(target, 1) });
      }
    } else {
      const step = spec.everyDays ?? MAINTENANCE_HISTORY_DAYS + 1;
      for (let ago = last.ago; ago <= MAINTENANCE_HISTORY_DAYS; ago += step) {
        let day = addDays(o.today, -(ago + (ago === last.ago ? 0 : Math.floor(rand() * 4))));
        if (isSunday(day)) day = addDays(day, -1);
        entries.push({ day, odometer: day <= lastFill ? readingOn(o.fills, day, drive.dailyKm) : null });
      }
    }
    entries.forEach((e, i) => {
      out.push({
        type: spec.type,
        day: e.day,
        cost: round(spec.cost[0] + rand() * (spec.cost[1] - spec.cost[0]), 0),
        odometer: e.odometer,
        vendor,
        notes: spec.notes[Math.floor(rand() * spec.notes.length)]!,
        nextDueDate: spec.everyDays && !('kmToDue' in last) ? addDays(e.day, spec.everyDays) : null,
        nextDueKm: spec.everyKm && e.odometer !== null ? round(e.odometer + spec.everyKm, 1) : null,
        latest: i === 0,
      });
    });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.type.localeCompare(b.type));
}

const money = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Generated PDF stored like an upload (category fuel_bill / maintenance_invoice, entity = the bus). */
async function storeDocument(
  tx: Tx,
  o: { schoolId: string; busId: string; adminId: string | null; category: 'fuel_bill' | 'maintenance_invoice'; fileName: string; title: string; meta: string[]; rows: { item: string; qty: string; rate: string; amount: string }[] },
): Promise<string> {
  const body = await renderPdf({
    title: o.title,
    meta: o.meta,
    columns: [
      { header: 'Item', width: 3, value: (r: (typeof o.rows)[number]) => r.item },
      { header: 'Quantity', align: 'right', value: (r) => r.qty },
      { header: 'Rate (INR)', align: 'right', value: (r) => r.rate },
      { header: 'Amount (INR)', align: 'right', value: (r) => r.amount },
    ],
    rows: o.rows,
    footer: 'Demo document generated by the seed',
  });
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const key = storage.schoolObjectKey({ schoolId: o.schoolId, category: o.category, entityId: o.busId, extension: 'pdf' });
  await storage.putObject({ key, body, contentType: 'application/pdf', checksum: sha256 });
  const file = await tx.one<{ id: string }>(
    `insert into files (school_id, key, category, entity_type, entity_id, mime, size_bytes, sha256, original_name, metadata, status, uploaded_by, uploader_type)
     values ($1, $2, $3, 'bus', $4, 'application/pdf', $5, $6, $7, '{"seeded": true}'::jsonb, 'uploaded', $8, 'user') returning id`,
    [o.schoolId, key, o.category, o.busId, body.length, sha256, o.fileName, o.adminId],
  );
  return file.id;
}

interface BusAnchor extends Record<string, unknown> {
  id: string;
  code: string;
  registration_no: string;
  status: string;
  fuel_type: string | null;
  last_known_odometer: number | null;
  first_trip_day: string | null;
  first_trip_reading: number | null;
  has_fuel: boolean;
  has_maintenance: boolean;
}

const FUEL_ITEM: Record<string, [string, string]> = { diesel: ['High speed diesel', 'L'], cng: ['Compressed natural gas', 'kg'], electric: ['Depot charging', 'kWh'] };

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger } = ctx;
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });
  const schools = await tx.many<{ id: string; code: string; name: string; today: string }>(
    `select id, code, name, to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as today
       from schools where code = any ($1) and deleted_at is null order by code`,
    [Object.keys(DEMO_FLEETS)],
  );
  const summary: Record<string, { fuelLogs: number; maintenanceLogs: number; documents: number }> = {};

  for (const school of schools) {
    await ctx.setContext({ schoolId: school.id, actorId: null, role: 'system' });
    const admin = await tx.maybeOne<{ id: string }>(
      "select id from users where school_id = $1 and role = 'school_admin' and deleted_at is null order by created_at, id limit 1",
      [school.id],
    );
    const buses = await tx.many<BusAnchor>(
      `select b.id, b.code, b.registration_no, b.status, b.fuel_type, b.last_known_odometer,
              ft.trip_date as first_trip_day, ft.start_odometer as first_trip_reading,
              exists (select 1 from fuel_logs f where f.bus_id = b.id) as has_fuel,
              exists (select 1 from maintenance_logs m where m.bus_id = b.id) as has_maintenance
         from buses b
         left join lateral (
           select t.trip_date, t.start_odometer from trips t
            where t.bus_id = b.id and t.start_odometer is not null order by t.trip_date, t.started_at nulls last limit 1
         ) ft on true
        where b.school_id = $1 and b.code = any ($2) and b.deleted_at is null
        order by b.code`,
      [school.id, DEMO_FLEETS[school.code]!.map((b) => b.code)],
    );
    const fuelRows: (string | number | null)[][] = [];
    const serviceRows: (string | number | null)[][] = [];
    let documents = 0;

    for (const bus of buses) {
      const odometer = Number(bus.last_known_odometer ?? DEMO_FLEETS[school.code]!.find((b) => b.code === bus.code)!.odometer);
      const inWorkshop = bus.status === 'maintenance';
      const lastDay = inWorkshop ? addDays(school.today, -18) : addDays(bus.first_trip_day ?? school.today, -1);
      const anchorDay = inWorkshop || !bus.first_trip_day ? addDays(lastDay, 1) : bus.first_trip_day;
      const anchorReading = bus.first_trip_reading !== null && !inWorkshop ? Number(bus.first_trip_reading) : odometer;
      const fuelType = bus.fuel_type ?? 'diesel';
      const fills = fuelSeries({ schoolCode: school.code, busCode: bus.code, fuelType, anchorDay, anchorReading, lastDay, fromDay: addDays(school.today, -FUEL_HISTORY_DAYS) });
      const at = (day: string) => `${day}T12:00:00Z`;

      if (!bus.has_fuel) {
        const latest = fills[fills.length - 1]!;
        const [item, unit] = FUEL_ITEM[fuelType] ?? FUEL_ITEM.diesel!;
        const billId = await storeDocument(tx, {
          schoolId: school.id, busId: bus.id, adminId: admin?.id ?? null, category: 'fuel_bill', fileName: `fuel-bill-${bus.code}-${latest.day}.pdf`,
          title: `Fuel bill · ${latest.station}`,
          meta: [school.name, `Date: ${latest.day}`, `Vehicle: ${bus.code} (${bus.registration_no})`, `Odometer: ${latest.entered ?? 'not noted'} km`],
          rows: [{ item, qty: `${latest.litres.toFixed(2)} ${unit}`, rate: money(latest.cost / latest.litres), amount: money(latest.cost) }],
        });
        documents += 1;
        for (const fl of fills) {
          fuelRows.push([bus.id, fl.day, fl.entered, fl.litres, fl.cost, fuelType, fl.station, fl === latest ? billId : null, fl.notes, admin?.id ?? null, at(fl.day)]);
        }
      }

      if (!bus.has_maintenance) {
        const services = maintenanceSeries({ schoolCode: school.code, busCode: bus.code, fills, busOdometer: odometer, today: school.today });
        const paid = services.filter((x) => x.latest && x.cost > 0).sort((a, b) => b.day.localeCompare(a.day))[0];
        for (const sv of services) {
          let invoiceId: string | null = null;
          if (sv === paid) {
            invoiceId = await storeDocument(tx, {
              schoolId: school.id, busId: bus.id, adminId: admin?.id ?? null, category: 'maintenance_invoice', fileName: `invoice-${bus.code}-${sv.day}.pdf`,
              title: `Service invoice · ${sv.vendor}`,
              meta: [school.name, `Date: ${sv.day}`, `Vehicle: ${bus.code} (${bus.registration_no})`, `Odometer: ${sv.odometer ?? 'in workshop'} km`],
              rows: [{ item: `${sv.type}: ${sv.notes}`, qty: '1', rate: money(sv.cost), amount: money(sv.cost) }],
            });
            documents += 1;
          }
          serviceRows.push([bus.id, sv.type, sv.day, sv.cost, sv.odometer, sv.vendor, sv.notes, invoiceId, sv.nextDueDate, sv.nextDueKm, admin?.id ?? null, at(sv.day)]);
        }
      }
    }

    const col = <T>(rows: (string | number | null)[][], i: number) => rows.map((r) => r[i] as T);
    if (fuelRows.length) {
      await tx.query(
        `insert into fuel_logs (school_id, bus_id, fuel_date, odometer, litres, cost, fuel_type, station, bill_file_id, notes, created_by, created_at, updated_at)
         select $1, x.bus_id, x.day, x.odometer, x.litres, x.cost, x.fuel_type, x.station, x.bill, x.notes, x.created_by, x.at, x.at
           from unnest($2::uuid[], $3::date[], $4::numeric[], $5::numeric[], $6::numeric[], $7::text[], $8::text[], $9::uuid[], $10::text[], $11::uuid[], $12::timestamptz[])
                as x(bus_id, day, odometer, litres, cost, fuel_type, station, bill, notes, created_by, at)`,
        [school.id, ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => col(fuelRows, i))],
      );
    }
    if (serviceRows.length) {
      await tx.query(
        `insert into maintenance_logs (school_id, bus_id, service_type, service_date, cost, odometer, vendor, notes, invoice_file_id, next_due_date, next_due_km,
                                       created_by, created_at, updated_at)
         select $1, x.bus_id, x.type, x.day, x.cost, x.odometer, x.vendor, x.notes, x.invoice, x.next_date, x.next_km, x.created_by, x.at, x.at
           from unnest($2::uuid[], $3::text[], $4::date[], $5::numeric[], $6::numeric[], $7::text[], $8::text[], $9::uuid[], $10::date[], $11::numeric[], $12::uuid[], $13::timestamptz[])
                as x(bus_id, type, day, cost, odometer, vendor, notes, invoice, next_date, next_km, created_by, at)`,
        [school.id, ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => col(serviceRows, i))],
      );
    }
    summary[school.code] = { fuelLogs: fuelRows.length, maintenanceLogs: serviceRows.length, documents };
  }
  logger.info({ summary }, 'Fleet operations seed applied');
}
