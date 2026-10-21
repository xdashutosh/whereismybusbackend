// School admin dashboard (BP §8.3 Dashboard, §13.3 Dashboard): total buses, active / completed /
// not-started trips of the school-local day, expiry alerts, odometer discrepancies, safety and route
// alerts, current document expiries, people counts and the quick links of the web admin — ONE
// statement in one READ ONLY tenant transaction (RLS scopes every table to the school).
//
// "Not started" = missed, or still scheduled past planned start + the school's grace minutes
// (school_settings.trip_not_started_grace_min) — the same rule as the trip-not-started job.
// Documents follow the document-expiry-scan scope: current bus documents of buses in service, current
// staff documents of active staff (licence scans superseded by the profile's licence expiry) and the
// licence expiry of active drivers.
import {
  DASHBOARD_ALERT_GROUPS,
  DASHBOARD_EXPIRY_WINDOW_DAYS,
  DASHBOARD_RECENT_DAYS,
  type AlertType,
  type DashboardAlertCounter,
  type DashboardAlertGroup,
  type DashboardQuickLink,
  type DashboardRecentAlert,
  type SchoolDashboard,
} from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';

export const DASHBOARD_LATEST_ALERTS = 5;

interface DashboardRow extends Record<string, unknown> {
  today: string;
  buses: { total: number; active: number; maintenance: number; inactive: number; retired: number; on_trip_now: number };
  trips: { active_now: number; total: number; upcoming: number; not_started: number; in_progress: number; completed: number; auto_closed: number; cancelled: number; non_school: number };
  alert_types: Record<string, [number, number, number]> | null;
  odometer_trips_recent: number;
  latest: Array<{ id: string; alert_type: AlertType; severity: DashboardRecentAlert['severity']; status: DashboardRecentAlert['status']; title: string; bus_id: string | null; bus_code: string | null; created_at: string }>;
  documents: { expired: number; expiring: number };
  people: { students: number; unassigned_students: number; drivers: number; conductors: number; parents: number };
}

const SEVERITY_RANK = `case a.severity when 'critical' then 3 when 'warning' then 2 else 1 end`;
const UNRESOLVED = `a.status in ('open', 'escalated')`;

// $1 timezone · $2 expiry window (days) · $3 recent window (days) · $4 latest alerts · $5 odometer alert types
const DASHBOARD_SQL = `
with ctx as (
  select (now() at time zone $1::text)::date as today,
         coalesce((select trip_not_started_grace_min from school_settings), 10) as grace
),
recent as (select ((ctx.today - ($3::int - 1))::timestamp at time zone $1::text) as since from ctx)
select to_char(ctx.today, 'YYYY-MM-DD') as today,
  (select jsonb_build_object(
            'total', count(*), 'active', count(*) filter (where b.status = 'active'),
            'maintenance', count(*) filter (where b.status = 'maintenance'), 'inactive', count(*) filter (where b.status = 'inactive'),
            'retired', count(*) filter (where b.status = 'retired'),
            'on_trip_now', count(*) filter (where exists (select 1 from trips x where x.bus_id = b.id and x.status = 'in_progress')))
     from buses b where b.deleted_at is null) as buses,
  (select jsonb_build_object(
            'active_now', (select count(*) from trips x where x.status = 'in_progress'),
            'total', count(*),
            'upcoming', count(*) filter (where t.status = 'scheduled' and (t.planned_start_at is null or t.planned_start_at + make_interval(mins => ctx.grace) >= now())),
            'not_started', count(*) filter (where t.status = 'missed' or (t.status = 'scheduled' and t.planned_start_at + make_interval(mins => ctx.grace) < now())),
            'in_progress', count(*) filter (where t.status = 'in_progress'),
            'completed', count(*) filter (where t.status = 'completed'),
            'auto_closed', count(*) filter (where t.status = 'auto_closed'),
            'cancelled', count(*) filter (where t.status = 'cancelled'),
            'non_school', count(*) filter (where t.trip_type = 'non_school'))
     from trips t where t.trip_date = ctx.today) as trips,
  (select jsonb_object_agg(g.alert_type, jsonb_build_array(g.open, g.critical, g.recent))
     from (select a.alert_type,
                  count(*) filter (where ${UNRESOLVED}) as open,
                  count(*) filter (where ${UNRESOLVED} and a.severity = 'critical') as critical,
                  count(*) filter (where a.created_at >= recent.since) as recent
             from alerts a cross join recent
            where ${UNRESOLVED} or a.created_at >= recent.since
            group by a.alert_type) g) as alert_types,
  (select count(distinct a.trip_id) from alerts a cross join recent
    where a.alert_type = any ($5::text[]) and a.created_at >= recent.since and a.trip_id is not null) as odometer_trips_recent,
  (select coalesce(jsonb_agg(l order by l.rank desc, l.created_at desc, l.id desc), '[]'::jsonb)
     from (select a.id, a.alert_type, a.severity, a.status, a.title, a.bus_id, coalesce(b.code, t.bus_code_snapshot) as bus_code,
                  a.created_at, ${SEVERITY_RANK} as rank
             from alerts a left join buses b on b.id = a.bus_id left join trips t on t.id = a.trip_id
            where ${UNRESOLVED}
            order by ${SEVERITY_RANK} desc, a.created_at desc, a.id desc
            limit $4) l) as latest,
  (select jsonb_build_object('expired', count(*) filter (where d.expiry_date < ctx.today),
                             'expiring', count(*) filter (where d.expiry_date >= ctx.today and d.expiry_date <= ctx.today + $2::int))
     from (select bd.expiry_date from bus_documents bd
             join buses b on b.id = bd.bus_id and b.deleted_at is null and b.status in ('active', 'maintenance')
            where bd.is_current and bd.deleted_at is null and bd.expiry_date is not null
           union all
           select sd.expiry_date from staff_documents sd
             join staff_profiles sp on sp.id = sd.staff_id and sp.deleted_at is null and sp.is_active
            where sd.is_current and sd.deleted_at is null and sd.expiry_date is not null
              and not (sd.doc_type in ('licence_front', 'licence_back') and sp.licence_expiry_date is not null)
           union all
           select sp.licence_expiry_date from staff_profiles sp
            where sp.deleted_at is null and sp.is_active and sp.staff_type = 'driver' and sp.licence_expiry_date is not null) d) as documents,
  (select jsonb_build_object(
            'students', (select count(*) from students s where s.deleted_at is null and s.is_active),
            'unassigned_students', (select count(*) from students s where s.deleted_at is null and s.is_active
                                       and not exists (select 1 from student_assignments sa where sa.student_id = s.id
                                                          and sa.valid_from <= ctx.today and (sa.valid_to is null or sa.valid_to > ctx.today))),
            'drivers', (select count(*) from staff_profiles sp where sp.deleted_at is null and sp.is_active and sp.staff_type = 'driver'),
            'conductors', (select count(*) from staff_profiles sp where sp.deleted_at is null and sp.is_active and sp.staff_type = 'conductor'),
            'parents', (select count(*) from school_parents p where p.deleted_at is null and p.is_active))) as people
  from ctx`;

function loadDashboard(tx: Tx, timezone: string): Promise<DashboardRow> {
  return tx.one<DashboardRow>(DASHBOARD_SQL, [timezone, DASHBOARD_EXPIRY_WINDOW_DAYS, DASHBOARD_RECENT_DAYS, DASHBOARD_LATEST_ALERTS, DASHBOARD_ALERT_GROUPS.odometer]);
}

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

function groupCounters(byType: Record<string, [number, number, number]> | null): Record<DashboardAlertGroup, DashboardAlertCounter> {
  const out = {} as Record<DashboardAlertGroup, DashboardAlertCounter>;
  for (const [group, types] of Object.entries(DASHBOARD_ALERT_GROUPS) as [DashboardAlertGroup, readonly AlertType[]][]) {
    const c: DashboardAlertCounter = { open: 0, critical: 0, recent: 0 };
    for (const t of types) {
      const v = byType?.[t];
      if (!v) continue;
      c.open += n(v[0]);
      c.critical += n(v[1]);
      c.recent += n(v[2]);
    }
    out[group] = c;
  }
  return out;
}

function quickLinks(d: Omit<SchoolDashboard, 'quickLinks'>): DashboardQuickLink[] {
  const t = d.trips.today;
  const service = d.alerts.byGroup.service.open;
  return [
    { key: 'liveFleet', label: 'Live fleet', path: '/school/live-fleet', count: d.trips.activeNow, state: d.trips.activeNow ? 'positive' : 'none' },
    // Web route of the Trips page: its date-range filter is `period=<from>..<to>` (school-local days).
    { key: 'trips', label: 'Today’s trips', path: `/school/trips?period=${d.localDate}..${d.localDate}`, count: t.total, state: t.notStarted ? 'critical' : 'information' },
    { key: 'alerts', label: 'Open alerts', path: '/school/alerts?status=open,escalated', count: d.alerts.open, state: d.alerts.critical ? 'negative' : d.alerts.open ? 'critical' : 'none' },
    { key: 'buses', label: 'Buses', path: '/school/buses', count: d.buses.total, state: d.documents.expired ? 'negative' : d.documents.expiringSoon ? 'critical' : 'none' },
    { key: 'maintenance', label: 'Service due', path: '/school/maintenance', count: service, state: d.alerts.byGroup.service.critical ? 'negative' : service ? 'critical' : 'none' },
    { key: 'students', label: 'Unassigned students', path: '/school/students?unassigned=true', count: d.people.unassignedStudents, state: d.people.unassignedStudents ? 'critical' : 'none' },
    { key: 'reports', label: 'Reports', path: '/school/reports', count: null, state: 'none' },
  ];
}

export function toDashboard(r: DashboardRow, timezone: string, generatedAt: string): SchoolDashboard {
  const byGroup = groupCounters(r.alert_types);
  let open = 0;
  let critical = 0;
  for (const v of Object.values(r.alert_types ?? {})) {
    open += n(v[0]);
    critical += n(v[1]);
  }
  const base: Omit<SchoolDashboard, 'quickLinks'> = {
    localDate: r.today,
    timezone,
    generatedAt,
    buses: { total: n(r.buses.total), active: n(r.buses.active), maintenance: n(r.buses.maintenance), inactive: n(r.buses.inactive), retired: n(r.buses.retired), onTripNow: n(r.buses.on_trip_now) },
    trips: {
      activeNow: n(r.trips.active_now),
      today: {
        total: n(r.trips.total), upcoming: n(r.trips.upcoming), notStarted: n(r.trips.not_started), inProgress: n(r.trips.in_progress),
        completed: n(r.trips.completed), autoClosed: n(r.trips.auto_closed), cancelled: n(r.trips.cancelled), nonSchool: n(r.trips.non_school),
      },
    },
    alerts: {
      open,
      critical,
      byGroup,
      latest: r.latest.map((a) => ({ id: a.id, alertType: a.alert_type, severity: a.severity, status: a.status, title: a.title, busId: a.bus_id, busCode: a.bus_code, createdAt: new Date(a.created_at).toISOString() })),
    },
    documents: { expired: n(r.documents.expired), expiringSoon: n(r.documents.expiring), windowDays: DASHBOARD_EXPIRY_WINDOW_DAYS },
    odometer: { discrepancyTripsRecent: n(r.odometer_trips_recent), recentDays: DASHBOARD_RECENT_DAYS },
    people: { students: n(r.people.students), unassignedStudents: n(r.people.unassigned_students), drivers: n(r.people.drivers), conductors: n(r.people.conductors), parents: n(r.people.parents) },
  };
  return { ...base, quickLinks: quickLinks(base) };
}

export async function getDashboard(req: Request): Promise<SchoolDashboard> {
  const timezone = req.tenant?.timezone ?? 'Asia/Kolkata';
  const row = await withRequestTenant(req, (tx) => loadDashboard(tx, timezone), { readOnly: true });
  return toDashboard(row, timezone, new Date().toISOString());
}
