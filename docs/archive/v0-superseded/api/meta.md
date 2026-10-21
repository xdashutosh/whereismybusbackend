# Meta & health API

Module `meta` (core) · contract: ARCHITECTURE §4, §17 "Meta / health" · source `backend/src/modules/meta/`.

All four endpoints are public and need no token. Responses never contain secrets or admin-only data.

| Endpoint | Mounted at |
|---|---|
| `GET /meta/config` | `/api/v1/meta/config` |
| `GET /meta/enums` | `/api/v1/meta/enums` |
| `GET /health` | `/health` and `/api/v1/health` |
| `GET /ready` | `/ready` and `/api/v1/ready` |

## GET /api/v1/meta/config

Client bootstrap configuration (`Cache-Control: public, max-age=60`). Values that come from platform
settings follow `PUT /admin/settings/:key` within the settings cache window (instantly in the same process).

```json
{ "success": true,
  "data": {
    "appName": "Where Is My Bus", "apiVersion": "v1", "defaultTimezone": "Asia/Kolkata",
    "mapTileUrl": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "captchaProvider": "builtin", "turnstileSiteKey": null,
    "freshness": { "liveSeconds": 30, "staleSeconds": 120 },
    "gps": { "minIntervalSeconds": 3, "maxBatchPoints": 50 },
    "search": { "exactRadiusMeters": 75, "nearbyRadiusMeters": 500, "maxCandidateStops": 6 },
    "passenger": { "nearbyBusRadiusMeters": 2000 },
    "scheduling": { "maxValidityDays": 31, "validityPresetDays": [1, 10, 15, 30] },
    "serverTime": "2026-10-17T08:31:00.000Z" } }
```

`captchaProvider` tells the client which CAPTCHA UI to show (see [auth.md](auth.md#get-authcaptcha));
`turnstileSiteKey` is set only for `turnstile`.

## GET /api/v1/meta/enums

Every enumeration with display labels (`Cache-Control: public, max-age=3600`). Values are identical to
the database CHECK constraints (a test enforces it).

```json
{ "success": true,
  "data": {
    "roles": [ { "value": "PASSENGER", "label": "Passenger" }, { "value": "DRIVER", "label": "Driver" },
               { "value": "DEPOT_ADMIN", "label": "Depot Admin" }, { "value": "REGION_ADMIN", "label": "Region Admin" },
               { "value": "STATE_ADMIN", "label": "State Admin" }, { "value": "SYSTEM_ADMIN", "label": "System Admin" } ],
    "tripStatuses": [ { "value": "SCHEDULED", "label": "Scheduled" }, … ],
    "…": [] } }
```

Lists: `roles, scopeLevels, tripStatuses, tripActions, completionSources, tripEventTypes, scheduleStatuses,
busStatuses, busTypes, fuelTypes, fuelUnits, maintenanceTypes, driverStatuses, attendanceStatuses,
attendanceSources, stopStatuses, stopClassifications, stopChangeRequestTypes, stopChangeRequestStatuses,
routeStatuses, directions, serviceTypes, documentOwnerTypes, documentKinds, importTypes, importStatuses,
importRowStatuses, importConflictPolicies, favoriteTypes, notificationTypes, subscriptionEvents,
notificationEventStatuses, noticeSeverities, freshness, etaBasis, matchTypes, conflictResources,
alertTypes, daysOfWeek`.

## GET /health

Liveness: the process is up (no dependency checks, `Cache-Control: no-store`, not request-logged).

```json
{ "success": true,
  "data": { "status": "ok", "service": "whereismybus-api", "environment": "development",
            "uptimeSeconds": 42, "serverTime": "…Z" } }
```

## GET /ready

Readiness: the database is reachable **and** every migration is applied. `200` when ready:

```json
{ "success": true,
  "data": { "ready": true, "status": "ready",
            "checks": { "database": { "ok": true, "latencyMs": 2 }, "migrations": { "ok": true, "pending": [] } },
            "serverTime": "…Z" } }
```

Otherwise `503 SERVICE_UNAVAILABLE`, for example:

```json
{ "success": false,
  "error": { "code": "SERVICE_UNAVAILABLE", "message": "The service is not ready.",
             "details": { "checks": { "database": { "ok": false, "error": "ECONNREFUSED" },
                                      "migrations": { "ok": false, "pending": [], "error": "DATABASE_UNAVAILABLE" } } },
             "requestId": "…" } }
```

## Conventions shared by every module

- Success: `{ "success": true, "data": …, "meta"? }`. Error:
  `{ "success": false, "error": { "code", "message", "details"?, "requestId" } }`. `X-Request-Id` is
  echoed (or generated).
- An unknown route returns `404 NOT_FOUND`; a malformed JSON body returns `400 VALIDATION_ERROR`; a body
  over 1 MB returns `413 PAYLOAD_TOO_LARGE`.
- Global rate limit: 600 requests/min per IP (`429 RATE_LIMITED` with `Retry-After`).
