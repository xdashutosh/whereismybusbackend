// App version gating (contract §9, BP §20 #7). Mobile clients send X-App-Name (driver_app |
// parent_app) and X-App-Version (semver). When platform_settings['min_supported_version'] holds a
// minimum for that app ({ "driver_app": "1.2.0", "parent_app": "1.0.0" }) and the client is older
// — or omits/garbles its version — the request fails with 426 APP_UPDATE_REQUIRED, so a broken
// build can be force-updated. Requests without X-App-Name (web, server-to-server) pass.
// Minimums are cached per process for MIN_VERSION_CACHE_MS and dropped on
// platform_settings.changed.
import { APP_NAMES, HEADERS, type AppName } from '@wimb/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isPgError, PG_ERROR } from '../db/pool.js';
import { withPlatform } from '../db/tenant.js';
import { appUpdateRequired } from '../shared/errors.js';
import { events } from '../shared/events.js';
import { logger as rootLogger } from '../shared/logger.js';
import { compareVersions, parseVersion } from '../shared/version.js';

const log = rootLogger.child({ module: 'version-gate' });
export const MIN_VERSION_SETTING_KEY = 'min_supported_version';
export const MIN_VERSION_CACHE_MS = 60_000;
const APP_SET: ReadonlySet<string> = new Set(APP_NAMES);

export type MinVersions = Partial<Record<AppName, string>>;
export type MinVersionLoader = () => Promise<MinVersions>;

/** Default loader: the platform setting, read as the platform (settings are super-admin rows). */
export const loadMinVersionsFromDb: MinVersionLoader = async () => {
  try {
    const row = await withPlatform({ actorId: null }, (tx) => tx.maybeOne<{ value: unknown }>('select value from platform_settings where key = $1', [MIN_VERSION_SETTING_KEY]), {
      readOnly: true,
    });
    const value = row?.value;
    if (!value || typeof value !== 'object') return {};
    const out: MinVersions = {};
    for (const [app, v] of Object.entries(value as Record<string, unknown>)) {
      if (APP_SET.has(app) && typeof v === 'string' && parseVersion(v)) out[app as AppName] = v;
    }
    return out;
  } catch (err) {
    if (isPgError(err, PG_ERROR.UNDEFINED_TABLE)) return {};
    throw err;
  }
};

export function versionGate({ loadMinVersions = loadMinVersionsFromDb, cacheMs = MIN_VERSION_CACHE_MS }: { loadMinVersions?: MinVersionLoader; cacheMs?: number } = {}): RequestHandler {
  let cached: { at: number; value: MinVersions } | null = null;
  events.on('platform_settings.changed', ({ key }) => {
    if (key === MIN_VERSION_SETTING_KEY) cached = null;
  });
  const minimums = async (): Promise<MinVersions> => {
    if (cached && Date.now() - cached.at < cacheMs) return cached.value;
    try {
      const value = await loadMinVersions();
      cached = { at: Date.now(), value };
      return value;
    } catch (err) {
      log.warn({ err: { message: (err as Error).message } }, 'Could not load minimum app versions; gate open');
      return cached?.value ?? {};
    }
  };
  return async function versionGateMiddleware(req: Request, _res: Response, next: NextFunction) {
    const app = req.get(HEADERS.APP_NAME);
    if (!app || !APP_SET.has(app)) return next();
    const min = (await minimums())[app as AppName];
    if (!min) return next();
    const current = req.get(HEADERS.APP_VERSION) ?? '';
    if (!parseVersion(current) || compareVersions(current, min) < 0) {
      throw appUpdateRequired(undefined, { app, minSupportedVersion: min, currentVersion: current || null });
    }
    return next();
  };
}
