// Global platform settings (BP §13.2 "Global settings", §20 #7; contract §9): default location
// intervals, moving speed / stopped-after thresholds, stale age, retention, document-expiry reminder
// days, trip timings, min_supported_version per app (version gate), notification modules and
// platform-wide feature flags. Every key is validated (@wimb/shared PLATFORM_SETTING_SCHEMAS);
// object-valued keys merge the given fields into the stored object. Changes are audited and
// announced with 'platform_settings.changed' (versionGate and other caches drop their copy).
import { MERGED_PLATFORM_SETTINGS, PLATFORM_SETTING_KEY_LIST, PLATFORM_SETTING_SCHEMAS, type PlatformSettingKey, type PlatformSettingsBody } from '@wimb/shared';
import type { Request } from 'express';
import { PLATFORM_SETTING_DEFAULTS } from '../../db/platformDefaults.js';
import { audit, changedFields } from '../../shared/audit.js';
import { validationError } from '../../shared/errors.js';
import { events } from '../../shared/events.js';
import { parseOrThrow } from '../../shared/validate.js';
import { toSettingDto } from './dto.js';
import type * as repo from './repository.js';
import { listSettings, upsertSettings } from './repository.js';
import { platformTx } from './schools.js';

const DEFAULTS = new Map(PLATFORM_SETTING_DEFAULTS.map((d) => [d.key, d]));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Stored rows plus defaults for any key missing in the table (never expected after migrations). */
function withDefaults(rows: repo.SettingRow[]): repo.SettingRow[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const d of PLATFORM_SETTING_DEFAULTS) {
    if (!byKey.has(d.key)) byKey.set(d.key, { key: d.key, value: d.value, description: d.description, is_public: d.isPublic, updated_by: null, updated_at: new Date(0).toISOString() });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** GET /platform/settings */
export async function getSettings(req: Request) {
  const rows = await platformTx(req, (tx) => listSettings(tx));
  return withDefaults(rows).map(toSettingDto);
}

/** Cross-field rules evaluated on the merged values. */
function assertConsistent(values: Map<string, unknown>): void {
  const moving = Number(values.get('location.moving_interval_s'));
  const stopped = Number(values.get('location.stopped_interval_s'));
  if (Number.isFinite(moving) && Number.isFinite(stopped) && stopped < moving) {
    throw validationError('The request is invalid.', [{ path: 'location.stopped_interval_s', message: 'Must be at least the moving interval' }]);
  }
}

/** PUT /platform/settings — any subset of the known keys; returns every setting. */
export async function putSettings(req: Request, body: PlatformSettingsBody) {
  const { rows, changedKeys } = await platformTx(req, async (tx) => {
    const current = withDefaults(await listSettings(tx, { lock: true }));
    const values = new Map<string, unknown>(current.map((r) => [r.key, r.value]));
    const changes: { key: PlatformSettingKey; value: unknown }[] = [];
    for (const key of PLATFORM_SETTING_KEY_LIST) {
      const given = body[key];
      if (given === undefined) continue;
      const before = values.get(key);
      let next: unknown = given;
      if (MERGED_PLATFORM_SETTINGS.includes(key) && isObject(before) && isObject(given)) {
        const merged = { ...before, ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) };
        next = parseOrThrow(PLATFORM_SETTING_SCHEMAS[key], merged, [key]);
      }
      if (JSON.stringify(next) === JSON.stringify(before)) continue;
      values.set(key, next);
      changes.push({ key, value: next });
    }
    assertConsistent(values);
    if (!changes.length) return { rows: current, changedKeys: [] as string[] };
    const byKey = new Map(current.map((r) => [r.key, r]));
    await upsertSettings(
      tx,
      changes.map((c) => ({ key: c.key, value: c.value, description: byKey.get(c.key)?.description ?? DEFAULTS.get(c.key)?.description ?? c.key, isPublic: byKey.get(c.key)?.is_public ?? DEFAULTS.get(c.key)?.isPublic ?? false })),
    );
    const diff = changedFields(
      Object.fromEntries(changes.map((c) => [c.key, byKey.get(c.key)?.value ?? null])),
      Object.fromEntries(changes.map((c) => [c.key, c.value])),
    );
    await audit.log(tx, { action: 'platform_settings.update', entityType: 'platform_settings', entityId: null, old: diff.old, new: diff.new });
    return { rows: withDefaults(await listSettings(tx)), changedKeys: changes.map((c) => c.key) };
  });
  for (const key of changedKeys) events.emit('platform_settings.changed', { key });
  return rows.map(toSettingDto);
}
