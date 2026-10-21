// Reports service (BP §8.3 Reports, §13.3 Reports): resolves the school-local date range, enforces the
// school's `reports` feature flag, checks the bus filter (another school's bus → 404) and runs the
// report's single aggregate statement — all in ONE read-only tenant transaction.
import { REPORT_DEFAULT_RANGE_DAYS, REPORT_MAX_RANGE_DAYS, type ReportKind, type ReportQuery, type ReportResponse, type ReportRowMap } from '@wimb/shared';
import type { Request } from 'express';
import { camelizeRows } from '../../db/pool.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { fieldError, forbidden, notFound } from '../../shared/errors.js';
import { MAX_EXPORT_ROWS } from '../../shared/pagination.js';
import { isFeatureEnabled } from '../school/index.js';
import { computeTotals, DEFINITIONS } from './definitions.js';
import type { SchoolHeader } from './render.js';
import * as repo from './repository.js';

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' ± n days (pure calendar arithmetic, no timezone involved). */
export function addDays(date: string, days: number): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/**
 * Date range of a report. Service due filters next due dates only when asked. Every other report:
 * neither bound → the last REPORT_DEFAULT_RANGE_DAYS days ending school-local today; only `to` → the
 * same number of days ending on `to`; only `from` → from `from` to today (or just `from` when it lies
 * in the future). At most REPORT_MAX_RANGE_DAYS days.
 */
export function resolveRange(kind: ReportKind, q: Pick<ReportQuery, 'from' | 'to'>, today: string): { from: string | null; to: string | null } {
  if (kind === 'service-due') return { from: q.from ?? null, to: q.to ?? null };
  let { from, to } = q;
  if (!from && !to) to = today;
  if (!from) from = addDays(to!, -(REPORT_DEFAULT_RANGE_DAYS - 1));
  if (!to) to = from > today ? from : today;
  const span = spanDays(from, to);
  if (span < 1) throw fieldError('from', 'from must be on or before to');
  if (span > REPORT_MAX_RANGE_DAYS) throw fieldError(q.to ? 'to' : 'from', `The date range may cover at most ${REPORT_MAX_RANGE_DAYS} days`);
  return { from, to };
}

export interface BuiltReport<K extends ReportKind = ReportKind> {
  report: ReportResponse<K>;
  school: SchoolHeader;
  /** Code of the filtered bus (PDF header), null when not filtered. */
  busLabel: string | null;
}

export async function buildReport<K extends ReportKind>(req: Request, kind: K, q: ReportQuery): Promise<BuiltReport<K>> {
  const timezone = req.tenant?.timezone ?? 'Asia/Kolkata';
  const def = DEFINITIONS[kind];
  const busId = q.busId ?? null;
  return withRequestTenant(
    req,
    async (tx) => {
      if (!(await isFeatureEnabled(tx, 'reports'))) {
        throw forbidden('Reports are not enabled for this school.', { reason: 'FEATURE_DISABLED', feature: 'reports' });
      }
      const ctx = await repo.loadContext(tx, timezone, busId);
      if (busId && !ctx.bus_found) throw notFound('The bus was not found.');
      const range = resolveRange(kind, q, ctx.today);
      const raw = await repo.runReport(tx, kind, { ...range, busId, today: ctx.today, cap: MAX_EXPORT_ROWS });
      const truncated = raw.length > MAX_EXPORT_ROWS;
      const rows = camelizeRows<ReportRowMap[K]>(truncated ? raw.slice(0, MAX_EXPORT_ROWS) : raw);
      const report: ReportResponse<K> = {
        report: kind,
        title: def.title,
        range,
        busId,
        timezone,
        generatedAt: new Date().toISOString(),
        columns: def.columns.map(({ key, label, type }) => ({ key, label, type })),
        rows,
        totals: computeTotals(def, rows as unknown as Record<string, unknown>[]),
        truncated,
      };
      const school: SchoolHeader = { schoolId: tx.ctx.schoolId!, name: ctx.school_name, code: ctx.school_code, logoKey: ctx.logo_key };
      return { report, school, busLabel: busId ? (ctx.bus_code ?? busId) : null };
    },
    { readOnly: true },
  );
}
