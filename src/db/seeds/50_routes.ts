// Seed 50 · routes (contract §14): per demo school two lines, each as a morning route (pick-up, stops in
// order towards the school) and an afternoon route (drop, same stops reversed) with 8 real-locality
// stops and expected times; planned paths (straight line through the stops and the school, flagged
// 'straight' — POST /school/routes/:id/recompute-polyline switches to Google once
// GOOGLE_MAPS_SERVER_KEY is set); bus R1 serves line 1 and R2 line 2 (bus ↔ route assignments) with
// Monday–Saturday trip schedules. Schools that do not exist yet are skipped.
// Idempotent: routes by (code, direction), stops only for routes without live stops, paths only when
// missing, assignments only without any history for that bus + route, schedules only when the bus has
// none on that route.
import { straightLineRoute } from '../../shared/routing.js';
import { buildPath } from '../../modules/routes/path.js';
import type { SeedContext } from '../seed.js';

type Stop = readonly [name: string, lat: number, lng: number];

interface Line {
  code: 'R1' | 'R2';
  name: string;
  busCode: string;
  stops: readonly Stop[];
}

interface SchoolRoutes {
  code: string;
  /** First morning pick-up and afternoon departure from the school ('HH:mm'). */
  morningStart: string;
  afternoonStart: string;
  /** Minutes between consecutive stops. */
  gapMin: number;
  lines: readonly [Line, Line];
}

export const DEMO_ROUTES: readonly SchoolRoutes[] = [
  {
    code: 'GWIS-BLR',
    morningStart: '07:00',
    afternoonStart: '14:30',
    gapMin: 5,
    lines: [
      {
        code: 'R1', name: 'Bellandur – HSR Layout', busCode: 'R1',
        stops: [
          ['Kaikondrahalli Lake', 12.9127, 77.674], ['Bellandur Gate', 12.9255, 77.676], ['Ibblur Junction', 12.9207, 77.6646],
          ['Agara Lake', 12.924, 77.647], ['HSR Layout Sector 7', 12.9105, 77.646], ['HSR BDA Complex', 12.9113, 77.639],
          ['Silk Board Junction', 12.9177, 77.6238], ["St. John's Hospital", 12.9285, 77.6196],
        ],
      },
      {
        code: 'R2', name: 'Indiranagar – Koramangala', busCode: 'R2',
        stops: [
          ['Indiranagar Metro Station', 12.9784, 77.6408], ['Indiranagar 100 Feet Road', 12.9719, 77.6412], ['Domlur Flyover', 12.9609, 77.6387],
          ['EGL Business Park', 12.9523, 77.6417], ['Ejipura Signal', 12.944, 77.626], ['Koramangala 6th Block', 12.939, 77.62],
          ['Sony World Signal', 12.9373, 77.6266], ['Koramangala 5th Block', 12.9352, 77.6245],
        ],
      },
    ],
  },
  {
    code: 'SUNRISE-JPR',
    morningStart: '07:10',
    afternoonStart: '14:00',
    gapMin: 5,
    lines: [
      {
        code: 'R1', name: 'Mansarovar – Durgapura', busCode: 'R1',
        stops: [
          ['Mansarovar Metro Station', 26.879, 75.755], ['VT Road Circle', 26.8573, 75.7655], ['Shipra Path', 26.8515, 75.7735],
          ['Gopalpura Bypass', 26.8633, 75.786], ['Triveni Nagar', 26.858, 75.787], ['Durgapura Flyover', 26.8512, 75.7948],
          ['Jawahar Circle', 26.841, 75.802], ['Gaurav Tower', 26.8556, 75.809],
        ],
      },
      {
        code: 'R2', name: 'Raja Park – Jhalana', busCode: 'R2',
        stops: [
          ['Raja Park', 26.902, 75.829], ['Jawahar Nagar', 26.892, 75.825], ['Bapu Nagar', 26.887, 75.813],
          ['Lal Kothi', 26.892, 75.804], ['Tonk Phatak', 26.8795, 75.798], ['Gandhi Nagar', 26.879, 75.808],
          ['Jhalana Doongri', 26.865, 75.818], ['Malviya Nagar Sector 7', 26.859, 75.817],
        ],
      },
    ],
  },
  {
    code: 'LAKEVIEW-HYD',
    morningStart: '07:05',
    afternoonStart: '15:00',
    gapMin: 6,
    lines: [
      {
        code: 'R1', name: 'Hitech City – Banjara Hills', busCode: 'R1',
        stops: [
          ['Hitech City Metro', 17.45, 78.381], ['Madhapur Ayyappa Society', 17.4435, 78.393], ['Jubilee Hills Road No. 36', 17.4312, 78.4025],
          ['Jubilee Hills Checkpost', 17.4298, 78.4122], ['KBR Park Gate', 17.4205, 78.422], ['Banjara Hills Road No. 2', 17.417, 78.438],
          ['Panjagutta Circle', 17.4262, 78.451], ['Erramanzil Colony', 17.419, 78.454],
        ],
      },
      {
        code: 'R2', name: 'Secunderabad – Khairatabad', busCode: 'R2',
        stops: [
          ['Paradise Circle', 17.443, 78.487], ['Rasoolpura', 17.444, 78.476], ['Begumpet Airport Road', 17.4455, 78.466],
          ['Prakash Nagar', 17.443, 78.459], ['Ameerpet Metro', 17.4375, 78.4483], ['Greenlands', 17.432, 78.456],
          ['Raj Bhavan Road', 17.426, 78.461], ['Khairatabad Circle', 17.412, 78.46],
        ],
      },
    ],
  },
  {
    code: 'RIVERSIDE-COK',
    morningStart: '08:00',
    afternoonStart: '16:30',
    gapMin: 5,
    lines: [
      {
        code: 'R1', name: 'Edappally – Kakkanad', busCode: 'R1',
        stops: [
          ['Lulu Mall Edappally', 10.0271, 76.308], ['Changampuzha Park', 10.0202, 76.3085], ['Palarivattom Junction', 10.0067, 76.3073],
          ['Pipeline Junction', 10.005, 76.315], ['Chembumukku', 10.0085, 76.329], ['Vazhakkala', 10.016, 76.3335],
          ['Padamugal', 10.0185, 76.338], ['Seaport–Airport Road Junction', 10.0175, 76.34],
        ],
      },
      {
        code: 'R2', name: 'Tripunithura – Vyttila', busCode: 'R2',
        stops: [
          ['Tripunithura Statue Junction', 9.9465, 76.348], ['Eroor North', 9.959, 76.339], ['Vyttila Hub', 9.9675, 76.3205],
          ['Thammanam', 9.983, 76.32], ['Kalavath Road', 9.993, 76.325], ['Chittethukara', 10.001, 76.348],
          ['Kakkanad Junction', 10.008, 76.346], ['Rajagiri Valley', 10.012, 76.344],
        ],
      },
    ],
  },
];

const addMinutes = (hhmm: string, minutes: number): string => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

export interface SeedRoute {
  code: string;
  name: string;
  direction: 'morning' | 'afternoon';
  busCode: string;
  plannedStart: string;
  stops: { name: string; code: string; lat: number; lng: number; time: string }[];
}

/** Morning: stops in order (first pick-up at morningStart); afternoon: reversed, leaving the school at afternoonStart. */
export function routesOf(s: SchoolRoutes): SeedRoute[] {
  return s.lines.flatMap((line) => {
    const prefix = line.code === 'R1' ? 'A' : 'B';
    const morning = line.stops.map(([name, lat, lng], i) => ({ name, code: `${prefix}${i + 1}`, lat, lng, time: addMinutes(s.morningStart, i * s.gapMin) }));
    const afternoon = [...line.stops].reverse().map(([name, lat, lng], i) => ({
      name, code: `${prefix}${line.stops.length - i}`, lat, lng, time: addMinutes(s.afternoonStart, 10 + i * s.gapMin),
    }));
    return [
      { code: line.code, name: `${line.name} (pick-up)`, direction: 'morning' as const, busCode: line.busCode, plannedStart: addMinutes(s.morningStart, -10), stops: morning },
      { code: line.code, name: `${line.name} (drop)`, direction: 'afternoon' as const, busCode: line.busCode, plannedStart: s.afternoonStart, stops: afternoon },
    ];
  });
}

export async function seed(ctx: SeedContext): Promise<void> {
  const { tx, logger } = ctx;
  await ctx.setContext({ schoolId: null, actorId: null, role: 'super_admin' });
  const schools = await tx.many<{ id: string; code: string; latitude: number | null; longitude: number | null }>(
    'select id, code, latitude, longitude from schools where code = any ($1) and deleted_at is null order by code',
    [DEMO_ROUTES.map((s) => s.code)],
  );
  const summary: Record<string, { routes: number; stops: number; schedules: number }> = {};

  for (const school of schools) {
    const routes = routesOf(DEMO_ROUTES.find((s) => s.code === school.code)!);
    await ctx.setContext({ schoolId: school.id, actorId: null, role: 'system' });
    const inserted = await tx.query(
      `insert into routes (school_id, code, name, direction, description)
       select $1, x.code, x.name, x.direction, 'Demo route (seed)'
         from unnest($2::text[], $3::text[], $4::text[]) as x(code, name, direction)
       on conflict (school_id, code, direction) where deleted_at is null do nothing`,
      [school.id, routes.map((r) => r.code), routes.map((r) => r.name), routes.map((r) => r.direction)],
    );

    // Stops only for routes that have none yet.
    const stopRows = routes.flatMap((r) => r.stops.map((s, i) => ({ ...s, route: r.code, direction: r.direction, seq: i + 1 })));
    const stops = await tx.query(
      `insert into stops (school_id, route_id, name, code, sequence, latitude, longitude, expected_time)
       select r.school_id, r.id, x.name, x.code, x.seq, x.lat, x.lng, x.time::time
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::numeric[], $8::numeric[], $9::text[])
              as x(route, direction, name, code, seq, lat, lng, time)
         join routes r on r.school_id = $1 and r.code = x.route and r.direction = x.direction and r.deleted_at is null
        where not exists (select 1 from stops s where s.route_id = r.id and s.deleted_at is null)`,
      [
        school.id,
        stopRows.map((s) => s.route),
        stopRows.map((s) => s.direction),
        stopRows.map((s) => s.name),
        stopRows.map((s) => s.code),
        stopRows.map((s) => s.seq),
        stopRows.map((s) => s.lat),
        stopRows.map((s) => s.lng),
        stopRows.map((s) => s.time),
      ],
    );

    // Planned paths for routes without one (straight line; recompute switches to Google once enabled).
    const live = await tx.many<{ id: string; direction: string; stops: { id: string; latitude: number; longitude: number }[] }>(
      `select r.id, r.direction,
              coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'latitude', s.latitude, 'longitude', s.longitude) order by s.sequence)
                          from stops s where s.route_id = r.id and s.deleted_at is null), '[]'::jsonb) as stops
         from routes r where r.school_id = $1 and r.deleted_at is null and r.polyline_encoded is null and r.code = any ($2)`,
      [school.id, [...new Set(routes.map((r) => r.code))]],
    );
    const location = school.latitude !== null && school.longitude !== null ? { latitude: Number(school.latitude), longitude: Number(school.longitude) } : null;
    const paths = live
      .map((r) => ({ id: r.id, path: buildPath(r.direction, r.stops, location) }))
      .filter((r) => r.path.points.length >= 2)
      .map((r) => ({ id: r.id, route: straightLineRoute(r.path.points, 'no_api_key') }));
    if (paths.length) {
      await tx.query(
        `update routes r set polyline_encoded = x.polyline, polyline_source = 'straight', polyline_computed_at = now(),
                distance_m = x.distance_m, duration_s = x.duration_s, updated_at = now()
           from unnest($1::uuid[], $2::text[], $3::int[], $4::int[]) as x(id, polyline, distance_m, duration_s)
          where r.id = x.id`,
        [paths.map((p) => p.id), paths.map((p) => p.route.polyline), paths.map((p) => p.route.distanceM), paths.map((p) => p.route.durationS)],
      );
    }

    // Bus ↔ route assignments (bus without any history on that route) and Monday–Saturday schedules.
    const args = [school.id, routes.map((r) => r.code), routes.map((r) => r.direction), routes.map((r) => r.busCode), routes.map((r) => r.plannedStart)];
    const pairs = `unnest($2::text[], $3::text[], $4::text[], $5::text[]) as x(route, direction, bus, start)
         join routes r on r.school_id = $1 and r.code = x.route and r.direction = x.direction and r.deleted_at is null
         join buses b on b.school_id = $1 and b.code = x.bus and b.deleted_at is null and b.status <> 'retired'`;
    await tx.query(
      `insert into bus_route_assignments (school_id, bus_id, route_id, valid_from)
       select $1, b.id, r.id, now() - interval '30 days' from ${pairs}
        where not exists (select 1 from bus_route_assignments a where a.bus_id = b.id and a.route_id = r.id)`,
      args,
    );
    const schedules = await tx.query(
      `insert into trip_schedules (school_id, bus_id, route_id, direction, name, planned_start_time, days_of_week, valid_from)
       select $1, b.id, r.id, r.direction, b.code || ' ' || r.direction, x.start::time, '{1,2,3,4,5,6}'::smallint[], (select app_local_date()) - 30
         from ${pairs}
        where not exists (select 1 from trip_schedules ts where ts.bus_id = b.id and ts.route_id = r.id and ts.deleted_at is null)`,
      args,
    );
    summary[school.code] = { routes: inserted.rowCount ?? 0, stops: stops.rowCount ?? 0, schedules: schedules.rowCount ?? 0 };
  }
  logger.info({ summary }, 'Routes seed applied');
}
