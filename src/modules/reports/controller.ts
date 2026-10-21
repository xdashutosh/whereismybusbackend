// HTTP layer of the reports module: read req.valid, build the report, send JSON / CSV / PDF.
import type { ReportKind, ReportQuery } from '@wimb/shared';
import type { Request, RequestHandler, Response } from 'express';
import { ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import { getDashboard } from './dashboard.js';
import { DEFINITIONS } from './definitions.js';
import { sendCsv, sendReportPdf } from './render.js';
import { buildReport } from './service.js';

/** GET /school/reports/{kind}. */
export function report(kind: ReportKind): RequestHandler {
  return async (req: Request, res: Response) => {
    const q = validated<ReportQuery>(req, 'query');
    const built = await buildReport(req, kind, q);
    if (q.format === 'csv') {
      await sendCsv(res, built.report);
      return;
    }
    if (q.format === 'pdf') {
      await sendReportPdf(res, built.report, DEFINITIONS[kind], built.school, built.busLabel);
      return;
    }
    ok(res, built.report);
  };
}

/** GET /school/dashboard. */
export async function dashboard(req: Request, res: Response) {
  ok(res, await getDashboard(req));
}
