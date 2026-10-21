# Settings & system status API

Module `settings` · base path `/api/v1` · contract: ARCHITECTURE §6, §7, §22 · source
`backend/src/modules/settings/` (validation, audit and caching in `backend/src/services/settingsService.js`).

| Endpoint | Roles |
|---|---|
| `GET /admin/settings` | every admin role |
| `PUT /admin/settings/:key` | `SYSTEM_ADMIN` |
| `GET /admin/system/status` | `SYSTEM_ADMIN` |

Other roles get `403 FORBIDDEN`; no token gives `401 UNAUTHENTICATED`.

## GET /admin/settings

All 26 platform settings of §7, sorted by key, read from the database (uncached):

```json
{ "success": true,
  "data": [
    { "key": "gps.freshSeconds", "value": 45, "defaultValue": 30,
      "description": "Fix age up to which a trip is LIVE.", "type": "integer", "min": 5, "max": 600,
      "unit": "seconds", "nullable": false,
      "updatedAt": "2026-10-17T08:40:00.000Z", "updatedBy": "078c…", "updatedByName": "System Administrator" },
    { "key": "scheduling.freeze", "value": false, "defaultValue": false,
      "description": "Freeze schedule/trip mutations for every non-system admin.", "type": "boolean",
      "nullable": false, "updatedAt": "…Z", "updatedBy": null, "updatedByName": null }
  ] }
```

`type` is `boolean` or `integer`. Integer settings carry `min`, `max` and `unit`. `nullable: true` means
`null` is accepted (only `trips.autoCancelUnstartedAfterMinutes`, where `null` disables auto-cancel).

| Key | Default | Bounds |
|---|---|---|
| `stops.depotAdminCreateEnabled` / `stops.stateAdminEditEnabled` / `stops.stateAdminDeleteEnabled` | `true` | boolean |
| `stops.duplicateRadiusMeters` | 50 | 1–1000 m |
| `stops.graceEditHours` | 24 | 0–720 h |
| `search.exactRadiusMeters` | 75 | 1–1000 m |
| `search.nearbyRadiusMeters` | 500 | 10–5000 m (≥ exact radius) |
| `search.maxCandidateStops` | 6 | 1–20 |
| `passenger.nearbyBusRadiusMeters` | 2000 | 100–20000 m |
| `routes.defaultAvgSpeedKmph` | 20 | 5–120 km/h |
| `scheduling.maxValidityDays` | 31 | 1–366 days |
| `scheduling.freeze` / `scheduling.allowCrossDepotResources` | `false` | boolean |
| `trips.startWindowBeforeMinutes` | 30 | 0–720 min |
| `trips.lateStartGraceMinutes` | 120 | 0–1440 min |
| `trips.autoDelayGraceMinutes` | 5 | 1–240 min |
| `trips.autoCancelUnstartedAfterMinutes` | 240 | 30–10080 min or `null` |
| `trips.driverCanSuspend` / `gps.ingestionEnabled` | `true` | boolean |
| `gps.minIntervalSeconds` | 3 | 1–60 s |
| `gps.historySampleSeconds` | 15 | 1–600 s |
| `gps.historyRetentionDays` | 30 | 1–3650 days |
| `gps.freshSeconds` | 30 | 5–600 s |
| `gps.staleSeconds` | 120 | 10–86400 s (> fresh) |
| `gps.maxAccuracyMeters` | 250 | 10–5000 m |
| `imports.maxRows` | 5000 | 1–20000 |

## PUT /admin/settings/:key

```http
PUT /api/v1/admin/settings/gps.freshSeconds
Content-Type: application/json

{ "value": 45, "reason": "Slower networks upcountry" }
```

`value` is any JSON value, validated against the key's rule; `reason` is optional (≤ 500 characters,
stored in the audit row).

```json
{ "success": true,
  "data": { "key": "gps.freshSeconds", "value": 45, "previousValue": 30, "changed": true, "defaultValue": 30,
            "description": "Fix age up to which a trip is LIVE.", "type": "integer", "min": 5, "max": 600,
            "unit": "seconds", "nullable": false, "updatedAt": "…Z", "updatedBy": "078c…",
            "updatedByName": "System Administrator" } }
```

- Writes are serialised (all settings rows are locked) and the **cross-key rules** are checked against
  the resulting state: `gps.staleSeconds > gps.freshSeconds` and
  `search.nearbyRadiusMeters ≥ search.exactRadiusMeters`.
- Audited as `settings.update` (entity type `PLATFORM_SETTING`, entity id = key,
  `before: { value }`, `after: { value }`, `reason`). Writing the current value is a no-op
  (`changed: false`, no audit row).
- After commit the settings cache is invalidated, so the next read anywhere (including `GET /meta/config`
  and permission hints in `GET /auth/me`) sees the new value.

| Error | When |
|---|---|
| `400 VALIDATION_ERROR` `path: "value"` | wrong type or out of bounds, cross-key rule broken, `value` missing, unknown body field, malformed key |
| `403 FORBIDDEN` | not SYSTEM_ADMIN |
| `404 NOT_FOUND` | unknown key |

## GET /admin/system/status

Operational health for the system administrator (`Cache-Control: no-store`). Every check runs in
parallel with a timeout and is isolated: a failing check never hides the others. A failure of the
critical `database` check makes the overall status `down`; any other failure makes it `degraded`.
The response contains **counters and booleans only, never secrets** (no connection strings, keys or
passwords).

```json
{ "success": true,
  "data": {
    "status": "ok",
    "checks": {
      "database": { "ok": true, "latencyMs": 1, "critical": true, "durationMs": 1 },
      "dbPool":   { "ok": true, "total": 1, "idle": 1, "waiting": 0, "max": 10, "critical": false, "durationMs": 1 },
      "storage":  { "ok": true, "driver": "local", "latencyMs": 0, "critical": false, "durationMs": 1 },
      "cache":    { "ok": true, "store": "memory", "hitRate": 0.333, "size": 2, "errors": 0, "critical": false, "durationMs": 1 },
      "workers":  { "ok": true, "running": true, "workers": [ { "name": "notification", "intervalMs": 2000, "running": false,
                    "runs": 10, "failures": 0, "lastRunAt": "…Z", "lastDurationMs": 0, "lastError": null } ],
                    "critical": false, "durationMs": 1 },
      "sse":      { "ok": true, "clients": 0, "channels": 0, "users": 0, "anonymousIps": 0, "published": 0, "dropped": 0,
                    "limits": { "perUser": 10, "perIp": 20, "global": 5000 }, "critical": false, "durationMs": 1 },
      "events":   { "ok": true, "emitted": 0, "failures": 0, "events": { "outbox.nudge": 1 }, "critical": false, "durationMs": 1 }
    },
    "info": { "environment": "development", "uptimeSeconds": 21, "nodeVersion": "v24.11.1",
              "defaultTimezone": "Asia/Kolkata", "captchaProvider": "builtin", "rateLimitEnabled": true,
              "storageDriver": "local", "storageConfigured": true, "smtpEnabled": false, "redisEnabled": false,
              "memoryRssMb": 105 },
    "providers": ["cache", "database", "dbPool", "events", "sse", "storage", "workers"],
    "collectedAt": "2026-10-17T08:31:28.676Z" } }
```

`providers` lists every registered check. Feature modules add their own with
`systemStatus.register(name, fn)` (for example the live module's `liveStore`), and these appear
automatically.
