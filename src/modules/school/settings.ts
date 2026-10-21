// School settings and the parent-visibility matrix (BP §8.3 GET/PUT /school/settings,
// /school/settings/parent-visibility; §13.3 Settings). Updates are partial (omitted fields keep
// their value), validated against the EFFECTIVE values (platform defaults for overrides left
// empty), audited with before/after values and announced with 'school.settings_changed'.
import {
  DEFAULT_PARENT_VISIBILITY,
  mergeParentVisibility,
  parentVisibilityIssues,
  schoolSettingsIssues,
  type AlertRecipient,
  type ParentVisibilityBody,
  type ParentVisibilityDto,
  type SchoolSettingsBody,
  type SchoolSettingsDto,
} from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { assertFound, validationError } from '../../shared/errors.js';
import { events } from '../../shared/events.js';
import { normalizePhone } from '../../shared/phone.js';
import * as repo from './repository.js';
import {
  PLATFORM_KEYS,
  SETTING_COLUMNS,
  featuresToDb,
  parentVisibilityToDb,
  readFeatures,
  readParentVisibility,
  recipientsToDb,
  settingsDto,
  type ScalarSettingField,
} from './settingsModel.js';

/** Settings of the current school inside an existing transaction (any school context). */
export async function loadSettings(tx: Tx, { lock = false } = {}): Promise<{ row: repo.SettingsRow; dto: SchoolSettingsDto }> {
  const row = assertFound(await repo.getSettings(tx, PLATFORM_KEYS, { lock }), 'The school settings were not found.');
  return { row, dto: settingsDto(row) };
}

/** GET /school/settings */
export function getSettings(req: Request): Promise<SchoolSettingsDto> {
  return withRequestTenant(req, async (tx) => (await loadSettings(tx)).dto, { readOnly: true });
}

/** Recipients: phones normalised, school admins must be active admins of THIS school, no duplicates. */
async function normaliseRecipients(tx: Tx, list: AlertRecipient[]): Promise<AlertRecipient[]> {
  const details: { path: string; message: string }[] = [];
  const out = list.map((r, i) => {
    const phone = r.phone ? normalizePhone(r.phone) : null;
    if (r.phone && !phone) details.push({ path: `alertRecipients[${i}].phone`, message: 'Must be a valid mobile number' });
    return { ...r, userId: r.userId ?? null, name: r.name ?? null, email: r.email ?? null, phone, alertTypes: r.alertTypes ? [...new Set(r.alertTypes)] : null };
  });
  const userIds = [...new Set(out.map((r) => r.userId).filter((v): v is string => Boolean(v)))];
  const active = await repo.activeAdminIds(tx, userIds);
  const seen = new Set<string>();
  out.forEach((r, i) => {
    if (r.userId && !active.has(r.userId)) details.push({ path: `alertRecipients[${i}].userId`, message: 'Must be an active school admin of this school' });
    const identity = r.userId ? `u:${r.userId}` : `c:${r.email ?? ''}|${r.phone ?? ''}`;
    if (seen.has(identity)) details.push({ path: `alertRecipients[${i}]`, message: 'Duplicate recipient' });
    seen.add(identity);
  });
  if (details.length) throw validationError('Some alert recipients are invalid.', details);
  return out;
}

const auditView = (d: SchoolSettingsDto) => {
  const { effective: _e, platformDefaults: _p, legal: _l, updatedAt: _u, updatedBy: _b, ...rest } = d;
  return rest as Record<string, unknown>;
};

/** PUT /school/settings */
export async function updateSettings(req: Request, body: SchoolSettingsBody): Promise<SchoolSettingsDto> {
  const result = await withRequestTenant(req, async (tx) => {
    const { dto: before } = await loadSettings(tx, { lock: true });
    const cols: Record<string, unknown> = {};
    for (const [field, column] of Object.entries(SETTING_COLUMNS) as [ScalarSettingField, string][]) {
      const v = body[field];
      if (v !== undefined) cols[column] = Array.isArray(v) ? [...v].sort((a, b) => b - a) : v;
    }
    if (body.alertRecipients !== undefined) cols.alert_recipients = JSON.stringify(recipientsToDb(await normaliseRecipients(tx, body.alertRecipients)));
    if (body.features !== undefined) cols.features = JSON.stringify(featuresToDb({ ...before.features, ...stripUndefined(body.features) }));

    const pick = <K extends ScalarSettingField>(k: K) => (body[k] !== undefined ? body[k] : before[k]) as SchoolSettingsDto[K];
    const issues = schoolSettingsIssues({
      movingIntervalS: pick('locationMovingIntervalS') ?? before.platformDefaults.movingIntervalS,
      stoppedIntervalS: pick('locationStoppedIntervalS') ?? before.platformDefaults.stoppedIntervalS,
      enableSpeedingAlert: pick('enableSpeedingAlert'),
      speedLimitKmh: pick('speedLimitKmh'),
      // Checked only when set: a later platform reduction must not block unrelated updates (the
      // effective value is capped at the platform maximum anyway).
      locationRetentionMonths: body.locationRetentionMonths,
      platformRetentionMonths: before.platformDefaults.locationRetentionMonths,
    });
    if (issues.length) throw validationError('The settings are inconsistent.', issues);
    if (!Object.keys(cols).length) return { dto: before, changed: [] as string[] };

    await repo.updateSettings(tx, cols);
    const { dto: after } = await loadSettings(tx);
    const diff = changedFields(auditView(before), auditView(after));
    const changed = Object.keys(diff.new);
    if (changed.length) await audit.log(tx, { action: 'school_settings.update', entityType: 'school_settings', entityId: tx.ctx.schoolId, ...diff });
    return { dto: after, changed };
  });
  if (result.changed.length) events.emit('school.settings_changed', { schoolId: req.tenant!.schoolId, changedFields: result.changed });
  return result.dto;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ── parent visibility ─────────────────────────────────────────────────────────
function visibilityDto(row: repo.SettingsRow): ParentVisibilityDto {
  return { matrix: readParentVisibility(row.parent_visibility), defaults: DEFAULT_PARENT_VISIBILITY, updatedAt: row.updated_at };
}

/** GET /school/settings/parent-visibility */
export function getParentVisibility(req: Request): Promise<ParentVisibilityDto> {
  return withRequestTenant(req, async (tx) => visibilityDto((await loadSettings(tx)).row), { readOnly: true });
}

/** PUT /school/settings/parent-visibility — partial matrix merged over the current one. */
export async function updateParentVisibility(req: Request, body: ParentVisibilityBody): Promise<ParentVisibilityDto> {
  const result = await withRequestTenant(req, async (tx) => {
    const { row } = await loadSettings(tx, { lock: true });
    const before = readParentVisibility(row.parent_visibility);
    const after = mergeParentVisibility(before, body);
    const issues = parentVisibilityIssues(after);
    if (issues.length) throw validationError('The parent visibility settings are inconsistent.', issues);
    const changed: string[] = [];
    for (const s of Object.keys(after) as (keyof typeof after)[]) {
      for (const [f, v] of Object.entries(after[s])) if ((before[s] as Record<string, boolean>)[f] !== v) changed.push(`${s}.${f}`);
    }
    if (!changed.length) return { dto: visibilityDto(row), changed };
    await repo.updateSettings(tx, { parent_visibility: JSON.stringify(parentVisibilityToDb(after)) });
    await audit.log(tx, {
      action: 'school_settings.parent_visibility_update',
      entityType: 'school_settings',
      entityId: tx.ctx.schoolId,
      old: Object.fromEntries(changed.map((p) => [p, !getPath(after, p)])),
      new: Object.fromEntries(changed.map((p) => [p, getPath(after, p)])),
    });
    return { dto: visibilityDto((await loadSettings(tx)).row), changed };
  });
  if (result.changed.length) events.emit('school.settings_changed', { schoolId: req.tenant!.schoolId, changedFields: result.changed.map((p) => `parentVisibility.${p}`) });
  return result.dto;
}

function getPath(m: Record<string, unknown>, path: string): boolean {
  const [s, f] = path.split('.') as [string, string];
  return Boolean((m[s] as Record<string, unknown>)[f]);
}

export { readFeatures, readParentVisibility };
