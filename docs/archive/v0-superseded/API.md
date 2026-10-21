# Where Is My Bus — API index

Base URL `http(s)://<host>/api/v1` (development: `http://localhost:4000/api/v1`). The binding contract is
[ARCHITECTURE.md](ARCHITECTURE.md) (§4 conventions, §5 auth, §6 scope, §17 endpoint catalogue); the
functional source is [CONSTITUTION.md](CONSTITUTION.md). Each module documents its exact requests,
responses and errors in `docs/api/<module>.md`.

## Conventions (ARCHITECTURE §4)

- JSON camelCase. Success `{ "success": true, "data": …, "meta"? }`; lists add
  `meta: { page, pageSize, total, totalPages }`. Error
  `{ "success": false, "error": { "code", "message", "details"?, "requestId" } }`.
- Authentication: `Authorization: Bearer <access token>` (15 min). Web clients refresh through the
  httpOnly cookie `wimb_rt` with `X-WIMB-Client: web`; mobile clients send the refresh token in the body
  (see [auth](api/auth.md)).
- Scope: authority always derives from the authenticated user row. A record outside your scope requested
  by id returns `404 NOT_FOUND`; a `regionId`/`depotId`/`stateId` filter outside it returns
  `403 OUT_OF_SCOPE`.
- Lists: `page`, `pageSize` (1–100), `sort=field|-field` (whitelisted), `q`; admin lists can be exported
  with `?format=csv`.
- Timestamps are ISO-8601 UTC. Service dates (`YYYY-MM-DD`) and local times (`HH:mm`) are in the state
  timezone.
- `Idempotency-Key` header on schedule/trip creation, import commit, driver start/end and GPS ingestion.

| Error code | HTTP |
|---|---|
| `VALIDATION_ERROR`, `CAPTCHA_REQUIRED`, `CAPTCHA_FAILED` | 400 |
| `UNAUTHENTICATED`, `TOKEN_EXPIRED` | 401 |
| `PASSWORD_CHANGE_REQUIRED`, `FORBIDDEN`, `OUT_OF_SCOPE`, `RESTRICTED_BY_SYSTEM` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT`, `DUPLICATE`, `DUPLICATE_STOP`, `SCHEDULE_CONFLICT`, `INVALID_STATE_TRANSITION`, `TRIP_START_WINDOW`, `TRIP_NOT_ACTIVE`, `RESOURCE_UNAVAILABLE`, `IN_USE`, `STALE_VERSION`, `IDEMPOTENCY_IN_PROGRESS` | 409 |
| `IDEMPOTENCY_KEY_REUSED` | 422 |
| `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_FILE` | 413 / 415 |
| `RATE_LIMITED` (+ `Retry-After`) | 429 |
| `INTERNAL_ERROR` / `SERVICE_UNAVAILABLE` | 500 / 503 |

## Modules

| Module | Endpoints | Status | Reference |
|---|---|---|---|
| Meta / health | `GET /meta/config` · `GET /meta/enums` · `GET /health` · `GET /ready` | **available** | [api/meta.md](api/meta.md) |
| Auth | `GET /auth/captcha` · `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/logout-all` · `POST /auth/forgot-password` · `POST /auth/reset-password` · `POST /auth/change-password` · `GET /auth/me` | **available** | [api/auth.md](api/auth.md) |
| Geo | `GET /admin/geo/tree` · `GET\|POST /admin/states` · `GET\|PATCH /admin/states/:id` · `GET\|POST /admin/regions` · `GET\|PATCH /admin/regions/:id` · `GET\|POST /admin/depots` · `GET\|PATCH /admin/depots/:id` | **available** | [api/geo.md](api/geo.md) |
| Users | `GET\|POST /admin/users` · `GET\|PATCH /admin/users/:id` · `POST /admin/users/:id/reset-password` | **available** | [api/users.md](api/users.md) |
| Settings / system | `GET /admin/settings` · `PUT /admin/settings/:key` · `GET /admin/system/status` | **available** | [api/settings.md](api/settings.md) |
| Audit | `GET /admin/audit-logs` (+ `?format=csv`) · `GET /admin/audit-logs/:id` | **available** | [api/audit.md](api/audit.md) |
| Stops | `/admin/stops…`, `/admin/stop-change-requests…` | pending | `api/stops.md` |
| Routes | `/admin/routes…` | pending | `api/routes.md` |
| Buses (+ documents) | `/admin/buses…`, `/admin/documents…` | pending | `api/buses.md` |
| Drivers (+ documents, attendance) | `/admin/drivers…` | pending | `api/drivers.md` |
| Imports | `/admin/imports…` | pending | `api/imports.md` |
| Schedules | `/admin/availability`, `/admin/schedules…` | pending | `api/schedules.md` |
| Trips | `/admin/trips…`, `/admin/driver-schedules`, `/admin/bus-schedules`, `/admin/system/trips/:id/force-status` | pending | `api/trips.md` |
| Driver app | `/driver/…` | pending | `api/driver.md` |
| Live GPS | `/live/…`, `/admin/live/…`, `/admin/trips/:id/track` | pending | `api/live.md` |
| ETA | (service used by live/passenger) | pending | `api/eta.md` |
| Passenger | `/passenger/…` | pending | `api/passenger.md` |
| Notifications | `/notifications…`, `/admin/notices`, `/admin/events` | pending | `api/notifications.md` |
| Dashboard | `GET /admin/dashboard` | pending | `api/dashboard.md` |

## Demo data

`npm run seed` (or `npm run db:reset -- --seed`) creates Karnataka (regions Bengaluru Central, Bengaluru
South and Mysuru; depots Shantinagar, Kengeri, Electronic City, Jayanagar and Mysuru City), Goa (North Goa,
Panaji) and the demo sign-ins listed in [api/auth.md](api/auth.md#demo-accounts-npm-run-seed).
