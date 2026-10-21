# Audit log API

Module `audit` · base path `/api/v1` · contract: ARCHITECTURE §3.1 (`audit_logs`), §4 (CSV), §6 · source
`backend/src/modules/audit/` (writes: `backend/src/services/auditService.js`).

Every administrative mutation writes one audit row **in the same transaction** as the change. Rows carry
the actor (user id and role), `action` (`entity.verb`, for example `user.create`, `depot.update`,
`settings.update`, `trip.cancel`), `entityType` (UPPER_SNAKE, for example `USER`, `DEPOT`,
`PLATFORM_SETTING`), `entityId`, the state/region/depot the change belongs to, `before`/`after` snapshots
(for updates only the changed fields; secrets such as passwords, hashes, tokens and GPS session ids are
replaced by `"[REDACTED]"`), an optional `reason`, and request metadata (request id, IP, user agent).

Roles: every admin role. Visibility follows each row's own hierarchy columns:

| Role | Sees rows whose… |
|---|---|
| DEPOT_ADMIN | `depotId` is their depot |
| REGION_ADMIN | `regionId` is their region |
| STATE_ADMIN | `stateId` is their state |
| SYSTEM_ADMIN | everything, including platform-wide rows without hierarchy (settings, …) |

## GET /admin/audit-logs

| Query | Meaning |
|---|---|
| `page`, `pageSize` | pagination (default 1 / 20, max 100) |
| `sort` | `occurredAt` (default `-occurredAt`), `action`, `entityType`, `actorName`, `id`; prefix `-` for descending |
| `action` | **prefix** match: `user.` = every user action, `trip.cancel` = that action |
| `entityType` | exact, UPPER_SNAKE (`USER`, `DEPOT`, …) |
| `entityId` | exact |
| `actorUserId` | uuid |
| `dateFrom`, `dateTo` | `YYYY-MM-DD` = whole calendar days in **your state's timezone** (SYSTEM: `DEFAULT_TIMEZONE`), inclusive; or ISO-8601 instants (`2026-10-12T00:00:00Z`), inclusive. `dateFrom` after `dateTo` returns `400` |
| `stateId`, `regionId`, `depotId` | narrow inside your scope; outside your scope returns `403 OUT_OF_SCOPE` (a DEPOT_ADMIN may not use `regionId`) |
| `format` | `json` (default) or `csv` |

```json
{ "success": true,
  "data": [ { "id": 1, "occurredAt": "2026-10-17T08:31:28.580Z",
              "actorUserId": "6fb5…", "actorName": "Bengaluru Central Region Admin", "actorRole": "REGION_ADMIN",
              "action": "depot.update", "entityType": "DEPOT", "entityId": "43bb…",
              "stateId": "aba9…", "stateName": "Karnataka", "regionId": "e5b8…", "regionName": "Bengaluru Central",
              "depotId": "43bb…", "depotName": "Kengeri",
              "reason": null, "requestId": "7d8eb971-1606-42d6-815f-a9790c01a929", "changedFields": ["phone"] } ],
  "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 } }
```

List entries omit the snapshots to keep the payload small; `changedFields` lists the keys present in
`before`/`after`. `id` is a number.

### CSV export: `?format=csv`

Uses the same filters and sort, capped at 10 000 rows, streamed as
`text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="audit-log-YYYY-MM-DD.csv"`
(UTF-8 BOM, CRLF). Columns: `ID, Occurred at (UTC), Actor, Actor role, Action, Entity type, Entity ID, State,
Region, Depot, Reason, Changed fields, Before, After, Request ID` (`Before`/`After` as JSON). Any cell
starting with `= + - @`, TAB or CR is prefixed with `'` to prevent formula injection.

## GET /admin/audit-logs/:id

`:id` is the positive integer id. Returns the list fields plus
`before`, `after`, `ip`, `userAgent` and `actorEmail`:

```json
{ "success": true,
  "data": { "id": 1, "action": "depot.update", "entityType": "DEPOT", "…": "…",
            "before": { "phone": "+91 80 4000 1002" }, "after": { "phone": "+91 80 4000 2002" },
            "ip": "::1", "userAgent": "curl/8.7.1", "actorEmail": "region.central@example.com" } }
```

An entry outside your scope returns `404 NOT_FOUND`; a non-numeric id returns `400 VALIDATION_ERROR`.

## Errors

| Code | When |
|---|---|
| `400 VALIDATION_ERROR` | bad filter value, unknown sort field, bad date, `dateFrom` > `dateTo`, non-numeric id |
| `403 FORBIDDEN` | not an admin role |
| `403 OUT_OF_SCOPE` | `stateId`/`regionId`/`depotId` outside your scope |
| `404 NOT_FOUND` | unknown id, or outside your scope |
