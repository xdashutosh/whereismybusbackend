# Where Is My Bus — Architecture & Build Contract

> **Deployment domain.** The platform is operated for **private schools, colleges and universities** in different Indian states, each running **its own bus fleet** for students and staff. Every institution is an **isolated tenant**; there is **no anonymous access** to rider data. This whole document uses the institutional nomenclature (Institution → Zone → Campus, Platform/Institution/Zone/Campus admins, Drivers, Riders). §26 is the domain summary and holds the **rename map** from the FRD's original terms (State/Region/Depot/Passenger), which `docs/CONSTITUTION.md` still uses.

This is the **binding technical contract** for every part of the system. It implements `docs/CONSTITUTION.md` (the FRD, cited as `FRD §n`; read its terms through the §26.1 map).
If code and this document disagree, fix the code, or update this document deliberately and say so. Never let implementation convenience break the transport model (FRD §27).

---

## 0. Repository layout

```
whereismybus/
  docs/
    CONSTITUTION.md        FRD (source of truth for behaviour)
    ARCHITECTURE.md        this contract
    API.md                 API index (links to docs/api/*.md)
    api/<module>.md        per-module endpoint reference with request/response examples
  backend/                 Node.js 24 + Express 5 + PostgreSQL (JavaScript, ESM)
  frontend/                React 19 + Vite + TypeScript + SAP UI5 Web Components for React
                           (admin console, rider web portal, driver web console)
  app/                     Flutter mobile app (rider + driver)
  README.md                setup / run instructions
```

Ports (dev): backend `4000`, frontend `5173` (Vite proxies `/api` → `http://localhost:4000`).

---

## 1. Technology decisions

| Concern | Choice |
|---|---|
| Runtime | Node.js 24, ESM (`"type": "module"`), JavaScript |
| HTTP | Express 5 (async errors propagate natively) |
| DB | PostgreSQL 14–18 (production: **Neon PostgreSQL 18**, via its PgBouncer pooler), driver `pg`. Raw SQL in repository files. Extensions: `btree_gist`, `pg_trgm`, `citext` (all standard contrib; **no PostGIS dependency**). See §25 for connectivity rules |
| File storage | S3-compatible object storage (Linode Object Storage) via `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`; private objects, short-lived presigned download URLs; `local` disk driver for tests. See §24 |
| Migrations | Plain SQL files `backend/migrations/NNN_name.sql`, own runner (`src/db/migrate.js`), table `schema_migrations` (+ checksum), one transaction per migration serialised with `pg_advisory_xact_lock` (pooler-safe, §25) |
| Validation | `zod@^3.25` (v3 API, import from `'zod'`) |
| Auth | Access JWT (HS256, 15 min) + opaque rotating refresh tokens (hashed in DB) ; `bcryptjs` |
| Logging | `pino` + `pino-http`, redaction of `authorization`, `cookie`, `password*`, `token*`, `refreshToken` |
| Security | `helmet`, `cors` (credentials, allow-list), `express-rate-limit`, `cookie-parser` |
| Uploads/Excel | `multer@2` (memory, 5 MB), `exceljs` (xlsx + csv) |
| Cache | Pluggable store: in-memory LRU+TTL (default, `lru-cache`), Redis (`ioredis`) when `REDIS_URL` set |
| Realtime | Server-Sent Events (SSE) hub; controlled polling fallback |
| Time | All instants `timestamptz` (UTC) ; local dates/times computed with the institution's IANA timezone (`institutions.timezone`) (default `Asia/Kolkata`) in SQL (`AT TIME ZONE`) or `luxon` |
| Tests | `vitest` + `supertest` against a real Postgres test database |
| Web UI | React 19, Vite, TypeScript, `@ui5/webcomponents-react` 2.x (+ `@ui5/webcomponents`, `-fiori`, `-icons`, `@ui5/webcomponents-react-charts`), theme **SAP Horizon** (`sap_horizon`), `@tanstack/react-query` v5, `react-router` v7, `leaflet` + `react-leaflet` v5 (OpenStreetMap tiles, URL configurable) |
| Mobile | Flutter 3.38 (Dart 3), `flutter_riverpod`, `go_router`, `dio`, `flutter_secure_storage`, `shared_preferences`, `flutter_map` + `latlong2`, `geolocator`, `flutter_svg`, `intl`, `connectivity_plus`, `wakelock_plus` |

---

## 2. Domain model (authoritative)

`Institution → Zone → Campus` is the administrative hierarchy. An **Institution** is a private school, college, university or education group (the tenant; owns the timezone); a **Zone** is a cluster of campuses inside one institution; a **Campus** is one site with its transport office / bus depot, which owns buses, drivers, routes, schedules and trips.
`Stop` (permanent, **institution-scoped** master data) → `Route` (directional — To campus (pickup) / From campus (drop) — owned by a campus, **versioned** ordered `RouteStop`s) → `Schedule` (recurring template: route + bus + driver + local departure time + validity) → `Trip` (one dated instance with its own lifecycle; holds the current bus+driver assignment) → `TripLiveState` (current GPS/ETA of an ACTIVE trip) + `TripLocationHistory` (sampled).
People: **Platform admins** (operator of the SaaS), **Institution / Zone / Campus admins** (the institution's transport staff), **Drivers** (one campus) and **Riders** (students, parents/guardians, staff — always members of exactly one institution, onboarded with a join code, §5).

Rules that are **never** violated:
1. A bus or a driver can never have two overlapping trip windows in status `SCHEDULED|DELAYED|ACTIVE|SUSPENDED` — enforced by PostgreSQL **exclusion constraints** (final truth), plus transactional pre-checks for friendly conflict reports.
2. At most one `ACTIVE` trip per driver and per bus — partial unique indexes.
3. Only the assigned driver can move a trip to `ACTIVE`; time passing never activates a trip.
4. GPS is accepted only for `ACTIVE` trips, only from the assigned driver with the trip's GPS session id.
5. Trips reference the `route_version_id` they were created with → editing a route never rewrites history.
6. Authorization scope is always derived from the authenticated user row loaded from the DB on every request — never from client-supplied ids, never from cache.
7. **Tenant isolation**: no user outside an institution (another institution's admins, drivers or riders, or an anonymous caller) can read, mutate, search, stream or infer that institution's stops, routes, buses, drivers, trips, live locations, riders or notifications. Only platform admins cross institutions. Every reference between rows (route ↔ stop, schedule ↔ bus/driver, rider ↔ assigned route/stop, join code ↔ campus) stays inside one institution.

---

## 3. Database schema (base migrations `001–099` plus the module ranges of §23)

Conventions: snake_case, `id uuid primary key default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` (trigger `set_updated_at`). Enumerations are `text` + `CHECK` (not PG enums). All FKs indexed.

DDL rules (verified empirically on PG 17):
- **Circular FK** `routes.current_version_id → route_versions`: create `routes`, then `route_versions`, then `ALTER TABLE routes ADD CONSTRAINT routes_current_version_fk FOREIGN KEY (current_version_id) REFERENCES route_versions(id) DEFERRABLE INITIALLY DEFERRED`.
- **Denormalized hierarchy columns** (`campuses.institution_id`, `users.zone_id/institution_id`, `routes.zone_id/institution_id`) are filled by `BEFORE INSERT OR UPDATE` triggers from the parent row **and** protected by composite FKs with `ON UPDATE CASCADE` so re-parenting a campus/zone keeps them consistent: `zones unique(id, institution_id)`; `campuses unique(id, zone_id, institution_id)` + `foreign key (zone_id, institution_id) references zones(id, institution_id) on update cascade`; `routes foreign key (campus_id, zone_id, institution_id) references campuses(id, zone_id, institution_id) on update cascade`; `users foreign key (campus_id, zone_id, institution_id) references campuses(id, zone_id, institution_id) on update cascade` and `foreign key (zone_id, institution_id) references zones(id, institution_id) on update cascade` (MATCH SIMPLE skips rows with NULLs, which is exactly the per-role behaviour wanted — e.g. a rider without a home campus has only `institution_id`). `stops.institution_id` is set from the creating campus (§14) and never changes (a campus can only be re-parented inside its institution).
- **Same-institution references** that a plain FK cannot express (route stops, schedule/trip bus and driver vs. route, rider assigned route/stop, join-code campus) are validated in the owning service inside the write transaction, and violations answer `VALIDATION_ERROR` without revealing the foreign row.
- Generated columns always `STORED`.
- **Never write a bare `ON CONFLICT DO NOTHING` on `trips`**: without an arbiter it also swallows exclusion-constraint violations (overlaps would be silently skipped). Always name the arbiter, e.g. `ON CONFLICT (schedule_id, service_date) WHERE schedule_id IS NOT NULL DO NOTHING`, so overlaps still raise `23P01`.
- Natural keys are normalised and case-insensitive: `buses.registration_no` upper-case without spaces `check (registration_no ~ '^[A-Z0-9-]+$')`; `drivers.employee_code citext unique`; `drivers.license_no` upper-case unique.

### 3.1 Hierarchy & identity
```
institutions(id, code text unique not null, name text not null, timezone text not null default 'Asia/Kolkata',
       institution_type text not null default 'SCHOOL' check in ('SCHOOL','COLLEGE','UNIVERSITY','GROUP'),
       legal_name text, contact_email citext, contact_phone text, website text, address text,
       is_active bool not null default true, created_at, updated_at)
zones(id, institution_id → institutions not null, code text not null, name text not null, is_active bool default true,
        created_at, updated_at, unique(institution_id, code))
campuses(id, zone_id → zones not null, institution_id → institutions not null  -- denormalized, kept consistent by trigger from zone
       code text unique not null, name text not null, address text, city text,
       geo_state text,            -- Indian state/UT where the campus is (e.g. 'Telangana'); a location label, not a hierarchy level
       pincode text, lat double precision, lng double precision,
       phone text, is_active bool default true, created_at, updated_at)

users(id, email citext unique, phone text unique, username citext unique,           -- username = driver employee code
      password_hash text not null, full_name text not null,
      role text not null check in ('RIDER','DRIVER','CAMPUS_ADMIN','ZONE_ADMIN','INSTITUTION_ADMIN','PLATFORM_ADMIN'),
      institution_id → institutions, zone_id → zones, campus_id → campuses,
      is_active bool not null default true, token_version int not null default 0,
      must_change_password bool not null default false,
      failed_login_count int not null default 0, last_failed_login_at timestamptz, last_login_at timestamptz,
      created_at, updated_at,
      check (email is not null or phone is not null or username is not null),
      check scope by role:
        CAMPUS_ADMIN, DRIVER → campus_id not null (zone_id/institution_id filled from campus by trigger)
        ZONE_ADMIN           → zone_id not null and campus_id is null (institution_id from zone by trigger)
        INSTITUTION_ADMIN    → institution_id not null and zone_id is null and campus_id is null
        RIDER                → institution_id not null; campus_id optional (home campus; zone_id/institution_id
                               filled from it by trigger); zone_id is null when campus_id is null
        PLATFORM_ADMIN       → institution_id, zone_id, campus_id all null)

rider_profiles(user_id pk → users on delete cascade, preferred_language text default 'en',
      rider_type text check in ('STUDENT','PARENT','STAFF','OTHER'),   -- from registration or the join code default
      enrolment_no text, ward_name text,              -- parent/guardian: child's name / class
      assigned_route_id → routes null, assigned_stop_id → stops null,
                                     -- validated: same institution as the rider; stop on the route's current version
      notify_trip_start bool default true, notify_delay bool default true, notify_cancellation bool default true,
      notify_suspension bool default true, notify_service_notice bool default true,
      home_stop_id → stops null, work_stop_id → stops null,   -- same institution as the rider
      created_at, updated_at)
      indexes: (assigned_route_id), (assigned_stop_id)

institution_join_codes(id, institution_id → institutions not null, campus_id → campuses null (same institution),
      code text unique not null check (code ~ '^[A-Z0-9]{8,12}$'),   -- stored upper-case, matched case-insensitively
      default_rider_type text check in ('STUDENT','PARENT','STAFF','OTHER'),
      max_uses int check (max_uses > 0), uses int not null default 0, expires_at timestamptz,
      is_active bool not null default true, created_by → users, created_at, updated_at)
      indexes: (institution_id), (campus_id)

refresh_tokens(id, user_id → users on delete cascade, token_hash text unique not null, family_id uuid not null,
      expires_at timestamptz not null, revoked_at timestamptz, replaced_by_id uuid, ip text, user_agent text, created_at)
password_reset_tokens(id, user_id → users on delete cascade, token_hash text unique not null, expires_at, used_at, created_at)
captcha_challenges(id, answer_hash text not null, expires_at timestamptz not null, used_at timestamptz, created_at)
idempotency_keys(user_id uuid not null, key text not null, method text not null, path text not null,
      request_hash text not null, status_code int, response_body jsonb, created_at, expires_at not null,
      primary key(user_id, key))
platform_settings(key text pk, value jsonb not null, description text, updated_by → users, updated_at)
audit_logs(id bigserial pk, occurred_at timestamptz default now(), actor_user_id → users, actor_role text,
      action text not null, entity_type text not null, entity_id text, institution_id uuid, zone_id uuid, campus_id uuid,
      before jsonb, after jsonb, reason text, request_id text, ip text, user_agent text)
      indexes: (occurred_at desc), (campus_id, occurred_at desc), (zone_id, occurred_at desc),
               (institution_id, occurred_at desc), (entity_type, entity_id), (actor_user_id, occurred_at desc)
```

### 3.2 Network
```
stops(id, code text unique not null default 'STP-' || lpad(nextval('stop_code_seq')::text, 6, '0'),
      name text not null, name_local text, lat double precision not null check (-90..90),
      lng double precision not null check (-180..180), classification text not null default 'MINOR' check in ('MAJOR','MINOR'),
      landmark text, address text, institution_id → institutions not null, created_by_campus_id → campuses, created_by → users,
      status text not null default 'ACTIVE' check in ('ACTIVE','INACTIVE'),
      is_established bool not null default false,   -- true once referenced by any route version
      deleted_at timestamptz, version int not null default 1, created_at, updated_at)
      indexes: (institution_id, lat, lng), gin (name gin_trgm_ops), (institution_id, lower(name)), partial where deleted_at is null
      -- every stop read/search filters by institution_id (tenant isolation; §14)
stop_change_requests(id, stop_id → stops not null, type text check in ('UPDATE','DEACTIVATE','DELETE'),
      proposed jsonb not null default '{}', reason text not null, requested_by → users not null,
      requested_by_campus_id → campuses, status text not null default 'PENDING'
      check in ('PENDING','APPROVED','REJECTED','CANCELLED'), reviewed_by → users, reviewed_at, review_note, created_at, updated_at)

routes(id, campus_id → campuses not null, zone_id, institution_id (denormalized from campus by trigger),
      code text not null, name text not null, direction text not null check in ('OUTBOUND','INBOUND'),
      pair_route_id → routes null, service_type text not null default 'ORDINARY'
      check in ('ORDINARY','EXPRESS','DELUXE','AC','ELECTRIC','NIGHT'),
      status text not null default 'ACTIVE' check in ('DRAFT','ACTIVE','INACTIVE'),
      current_version_id uuid null (FK → route_versions, deferrable initially deferred),
      origin_stop_id → stops, destination_stop_id → stops, total_distance_m int, total_duration_min int,
      created_by → users, created_at, updated_at, unique(institution_id, code, direction))
route_versions(id, route_id → routes not null, version_no int not null, notes text, created_by → users, created_at,
      unique(route_id, version_no))
route_stops(id, route_version_id → route_versions on delete cascade not null, stop_id → stops not null,
      seq int not null check (seq >= 1), distance_from_origin_m int not null default 0,
      planned_offset_min int not null default 0,     -- minutes from trip start to arrival at this stop
      unique(route_version_id, seq), unique(route_version_id, stop_id))
      indexes: (stop_id), (route_version_id, seq)
```
`planned_offset_min` must be non-decreasing with `seq`; seq 1 has offset 0 and distance 0. Every `route_stops.stop_id` belongs to the route's institution. `direction` keeps the values `OUTBOUND` / `INBOUND`; UIs label them **To campus (pickup)** / **From campus (drop)**.

### 3.3 Fleet
```
buses(id, campus_id → campuses not null, registration_no text unique not null (uppercase, no spaces), fleet_no text,
      make text, model text, capacity int check (capacity > 0),
      bus_type text not null default 'ORDINARY' check in ('ORDINARY','EXPRESS','DELUXE','AC','SLEEPER','ELECTRIC','MINI'),
      fuel_type text not null default 'DIESEL' check in ('DIESEL','CNG','ELECTRIC','HYBRID','PETROL'),
      manufacture_year int, status text not null default 'ACTIVE' check in ('ACTIVE','MAINTENANCE','INACTIVE'),
      insurance_expiry date, fitness_expiry date, permit_expiry date, odometer_km int, notes text, created_at, updated_at,
      unique(campus_id, fleet_no))
bus_maintenance_records(id, bus_id → buses on delete cascade, service_date date not null,
      type text check in ('SERVICE','REPAIR','INSPECTION','TYRE','OTHER'), description text, odometer_km int,
      cost numeric(12,2), vendor text, next_due_date date, created_by → users, created_at)
bus_fuel_records(id, bus_id → buses on delete cascade, filled_at timestamptz not null, quantity numeric(10,2) not null,
      unit text not null check in ('LITRE','KG','KWH'), cost numeric(12,2), odometer_km int, station text,
      created_by → users, created_at)

drivers(id, campus_id → campuses not null, user_id → users unique null, employee_code text unique not null,
      full_name text not null, phone text not null, email citext, license_no text unique not null, license_expiry date not null,
      date_of_birth date, date_of_joining date, blood_group text, address text, emergency_contact text,
      status text not null default 'ACTIVE' check in ('ACTIVE','ON_LEAVE','SUSPENDED','INACTIVE'), created_at, updated_at)
driver_attendance(id, driver_id → drivers on delete cascade, date date not null,
      status text not null check in ('PRESENT','ABSENT','LEAVE','OFF'), check_in_at timestamptz, check_out_at timestamptz,
      source text not null default 'MANUAL' check in ('MANUAL','AUTO'), notes text, recorded_by → users,
      created_at, updated_at, unique(driver_id, date))

import_batches(id, type text check in ('DRIVERS','BUSES'), campus_id → campuses not null, file_name text,
      status text not null default 'STAGED' check in ('STAGED','COMMITTED','CANCELLED','FAILED'),
      total_rows int, valid_rows int, invalid_rows int, duplicate_rows int, existing_rows int,
      conflict_policy text check in ('SKIP','UPDATE'), summary jsonb, created_by → users, created_at,
      committed_by → users, committed_at)
import_rows(id bigserial pk, batch_id → import_batches on delete cascade, row_no int not null, raw jsonb, data jsonb,
      status text not null check in ('VALID','INVALID','DUPLICATE_IN_FILE','EXISTS','COMMITTED','SKIPPED','UPDATED'),
      errors jsonb not null default '[]', entity_id uuid)
```

### 3.4 Scheduling & trips
```
schedules(id, campus_id → campuses not null, route_id → routes not null, route_version_id → route_versions not null,
      bus_id → buses not null, driver_id → drivers not null, departure_time time not null,  -- local time in institution tz
      duration_min int not null check (duration_min between 5 and 1440),
      days_of_week smallint[] not null default '{1,2,3,4,5,6,7}',   -- ISO 1=Mon … 7=Sun
      valid_from date not null, valid_to date not null, check (valid_to >= valid_from),
      status text not null default 'ACTIVE' check in ('ACTIVE','INACTIVE','CANCELLED'), notes text,
      version int not null default 1, created_by → users, updated_by → users, created_at, updated_at)

trips(id, schedule_id → schedules null, campus_id → campuses not null, route_id → routes not null,
      route_version_id → route_versions not null, bus_id → buses not null, driver_id → drivers not null,
      service_date date not null, planned_start timestamptz not null, planned_end timestamptz not null,
      check (planned_end > planned_start),
      status text not null default 'SCHEDULED'
        check in ('SCHEDULED','DELAYED','ACTIVE','COMPLETED','CANCELLED','SUSPENDED'),
      status_before_suspend text, delay_minutes int not null default 0, delay_reason text,
      actual_start timestamptz, actual_end timestamptz, cancel_reason text, suspend_reason text,
      completion_source text check in ('DRIVER','ADMIN','SYSTEM'), gps_session_id uuid,
      started_by → users, ended_by → users, version int not null default 1,
      created_by → users, created_at, updated_at,
      occupancy tstzrange generated always as (tstzrange(planned_start, planned_end, '[)')) stored,
      constraint trips_no_driver_overlap exclude using gist (driver_id with =, occupancy with &&)
        where (status in ('SCHEDULED','DELAYED','ACTIVE','SUSPENDED')),
      constraint trips_no_bus_overlap exclude using gist (bus_id with =, occupancy with &&)
        where (status in ('SCHEDULED','DELAYED','ACTIVE','SUSPENDED')))
  unique index trips_schedule_day_uq on trips(schedule_id, service_date) where schedule_id is not null
  unique index trips_one_active_driver on trips(driver_id) where status = 'ACTIVE'
  unique index trips_one_active_bus    on trips(bus_id)    where status = 'ACTIVE'
  indexes: (driver_id, planned_start), (bus_id, planned_start), (route_id, service_date),
           (campus_id, service_date, status), (status, planned_start)

trip_assignment_history(id bigserial pk, trip_id → trips on delete cascade, bus_id → buses, driver_id → drivers,
      assigned_at timestamptz default now(), assigned_by → users, reason text, unassigned_at timestamptz)
trip_events(id bigserial pk, trip_id → trips on delete cascade, campus_id uuid, event_type text not null
      check in ('CREATED','STATUS_CHANGED','DELAY_REPORTED','REASSIGNED','RESCHEDULED','NOTE','GPS_LOST','GPS_RESTORED'),
      from_status text, to_status text, actor_user_id → users, actor_role text, reason text, data jsonb, created_at)
      indexes: (trip_id, created_at), (campus_id, created_at desc)

trip_live_state(trip_id pk → trips on delete cascade, lat double precision not null, lng double precision not null,
      accuracy_m real, speed_mps real, heading_deg real, recorded_at timestamptz not null, received_at timestamptz not null,
      progress_m int, last_passed_seq int, next_stop_seq int, off_route bool not null default false,
      eta jsonb, eta_computed_at timestamptz, updated_at timestamptz not null default now())
trip_location_history(id bigserial pk, trip_id → trips on delete cascade, lat, lng, accuracy_m real, speed_mps real,
      heading_deg real, recorded_at timestamptz not null, received_at timestamptz not null)
      index (trip_id, recorded_at)
```

### 3.5 Rider, notifications
```
favorites(id, user_id → users on delete cascade, type text check in ('ROUTE','SCHEDULE','TRIP','STOP','STOP_PAIR'),
      route_id → routes, schedule_id → schedules, trip_id → trips, stop_id → stops, from_stop_id → stops, to_stop_id → stops,
      label text, target_key text not null, created_at, unique(user_id, target_key))
recent_searches(id bigserial pk, user_id → users on delete cascade, from_stop_id → stops, to_stop_id → stops,
      from_label text, to_label text, from_lat double precision, from_lng double precision, searched_at timestamptz default now())
notification_subscriptions(id, user_id → users on delete cascade, trip_id → trips, schedule_id → schedules,
      stop_id → stops (stop of interest; same institution), events text[] not null
        default '{TRIP_STARTED,TRIP_DELAYED,TRIP_CANCELLED,TRIP_SUSPENDED,TRIP_RESUMED,APPROACHING_STOP}',
                                     -- APPROACHING_STOP is only delivered when stop_id is set (§12)
      is_active bool not null default true, created_at, updated_at,
      check (num_nonnulls(trip_id, schedule_id) = 1))
      unique (user_id, trip_id) where trip_id not null ; unique (user_id, schedule_id) where schedule_id not null
notification_events(id, event_type text not null, trip_id → trips, schedule_id → schedules, route_id → routes,
      campus_id → campuses, payload jsonb not null default '{}',
      status text not null default 'PENDING' check in ('PENDING','PROCESSING','DONE','FAILED'),
      attempts int not null default 0, last_error text,
      available_at timestamptz not null default now(),   -- retry back-off
      locked_until timestamptz,                          -- reclaim events stuck in PROCESSING after a crash
      created_at, processed_at)
      index (status, available_at)
      unique index notification_events_approaching_uq on notification_events (trip_id, (payload->>'stopId'))
        where event_type = 'APPROACHING_STOP'                 -- one APPROACHING_STOP per trip and stop
notifications(id, user_id → users on delete cascade, event_id → notification_events, type text not null,
      title text not null, body text not null, data jsonb not null default '{}', read_at timestamptz, created_at)
      unique (user_id, event_id) where event_id is not null      -- fan-out is idempotent (ON CONFLICT DO NOTHING)
      indexes: (user_id, created_at desc), partial (user_id) where read_at is null
service_notices(id, institution_id → institutions not null, campus_id → campuses, route_id → routes,
      title text not null, body text not null,     -- institution_id derived from campus/route; never crosses tenants
      severity text check in ('INFO','WARNING','CRITICAL') default 'INFO', created_by → users, created_at)
```

### 3.6 Documents (file metadata; bytes live in object storage)
```
documents(id, owner_type text not null check in ('DRIVER','BUS','IMPORT'), owner_id uuid not null,
      campus_id → campuses not null,                   -- scope of the owner, for authorization
      kind text not null check in ('PHOTO','LICENSE','ID_PROOF','RC','INSURANCE','FITNESS','PERMIT','IMPORT_SOURCE','OTHER'),
      file_name text not null, content_type text not null, size_bytes int not null check (size_bytes > 0),
      storage_key text unique not null, checksum_sha256 text not null, valid_until date, notes text,
      uploaded_by → users, created_at, deleted_at timestamptz)
      index (owner_type, owner_id) where deleted_at is null ; index (campus_id)
```

Event type vocabulary (notification_events.event_type / notifications.type):
`TRIP_STARTED, TRIP_DELAYED, TRIP_CANCELLED, TRIP_SUSPENDED, TRIP_RESUMED, TRIP_COMPLETED, APPROACHING_STOP, SCHEDULE_CANCELLED, SERVICE_NOTICE, STOP_CHANGE_REQUESTED, STOP_CHANGE_REVIEWED, IMPORT_COMMITTED`.

---

## 4. API conventions

- Base path **`/api/v1`**. Health: `GET /health` and `GET /ready` (also mounted at `/api/v1/health`, `/api/v1/ready`).
- JSON **camelCase** on the wire; snake_case in DB (repositories map rows → DTOs; never leak `password_hash`, token hashes, internal columns).
- Success envelope:
  `{ "success": true, "data": <object|array>, "meta": { "page":1, "pageSize":20, "total":134, "totalPages":7 } }` (`meta` only for lists).
- Error envelope:
  `{ "success": false, "error": { "code": "SCHEDULE_CONFLICT", "message": "Human readable", "details": <any>, "requestId": "…" } }`
- Error codes → HTTP: `VALIDATION_ERROR` 400, `CAPTCHA_REQUIRED` 400, `CAPTCHA_FAILED` 400, `UNAUTHENTICATED` 401, `TOKEN_EXPIRED` 401, `PASSWORD_CHANGE_REQUIRED` 403, `FORBIDDEN` 403, `OUT_OF_SCOPE` 403, `RESTRICTED_BY_SYSTEM` 403, `NOT_FOUND` 404, `CONFLICT` 409, `DUPLICATE` 409, `DUPLICATE_STOP` 409, `SCHEDULE_CONFLICT` 409, `INVALID_STATE_TRANSITION` 409, `TRIP_START_WINDOW` 409, `TRIP_NOT_ACTIVE` 409, `RESOURCE_UNAVAILABLE` 409, `IN_USE` 409, `STALE_VERSION` 409, `IDEMPOTENCY_KEY_REUSED` 422, `IDEMPOTENCY_IN_PROGRESS` 409, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_FILE` 415, `RATE_LIMITED` 429 (+`Retry-After`), `INTERNAL_ERROR` 500, `SERVICE_UNAVAILABLE` 503.
  `VALIDATION_ERROR.details = [{ "path": "stops[2].stopId", "message": "…" }]`.
  `SCHEDULE_CONFLICT.details = { "conflicts": [{ "resource": "BUS"|"DRIVER", "resourceId", "label", "serviceDate", "requestedStart", "requestedEnd", "conflictingTripId", "conflictingStart", "conflictingEnd", "routeCode" }] }`.
- PG error mapping (central): `23505` → `DUPLICATE` (409, constraint name in details), `23P01` → `SCHEDULE_CONFLICT`, `23503` → `CONFLICT`/`VALIDATION_ERROR`, `22P02`/`22007`/`22008` → `VALIDATION_ERROR`.
- Unknown route → 404 `NOT_FOUND` envelope. Unhandled error → 500 `INTERNAL_ERROR` (no stack in production; logged with requestId).
- Pagination: `page` (≥1, default 1), `pageSize` (1–100, default 20). Sorting: `sort=field` / `sort=-field`, whitelisted per endpoint (else `VALIDATION_ERROR`). Free text: `q`. Lists are always bounded.
- IDs are UUIDs; invalid UUID in path → 400. Resource outside caller scope requested **by id** → 404 `NOT_FOUND` (no existence leak). An explicit filter (`institutionId`, `zoneId`, `campusId`) outside scope → 403 `OUT_OF_SCOPE`. Another institution's rows are always "outside scope" for everyone but platform admins (riders and drivers included).
- Timestamps: ISO-8601 UTC (`2026-10-16T18:30:00.000Z`). Service dates `YYYY-MM-DD` and local times `HH:mm` are in the **institution timezone** (`institutions.timezone`); responses that carry local values also carry `timezone`.
- Request id: accept/generate `X-Request-Id`, echo in response header and error envelope.
- Idempotency: `Idempotency-Key` header (8–128 chars) honoured on `POST /admin/schedules`, `POST /admin/trips`, `POST /admin/imports/:id/commit`, `POST /driver/trips/:id/start|end`, `POST /live/trips/:id/locations`. Same key + same body hash → replay stored response (header `Idempotent-Replayed: true`); same key + different body → 422; concurrent in-flight → 409. Keys expire after 24 h. Clients must **never** blindly retry trip/schedule creation without the same key.
- Validation middleware stores parsed input in **`req.valid.body|query|params`** (Express 5 `req.query` is a read-only getter — never assign it).
- Bounded payloads: JSON body limit 1 MB; uploads 5 MB (documents 10 MB); GPS batch ≤ 50 points.
- **Display-ready DTOs**: list and detail responses include the display names of referenced entities (`routeCode`, `routeName`, `busRegistrationNo`, `driverName`, `driverEmployeeCode`, `campusName`, `campusCode`, `zoneName`, `institutionName`, `createdByName`, …) computed in the same SQL query — clients never have to resolve bare ids.
- **Permission hints**: detail DTOs carry `permissions` (e.g. stop `{ canEdit, canDelete, canRequestChange, requiresReason }`) and trips carry `allowedActions: ['DELAY','SUSPEND','RESUME','CANCEL','COMPLETE','REASSIGN','RESCHEDULE']` computed by the same service rules the mutation endpoints enforce (the server still re-checks on mutation).
- **CSV export**: `GET /admin/{stops|routes|buses|drivers|schedules|trips|riders|audit-logs}?format=csv` streams the filtered list (same filters/sort, max 10 000 rows). Every exported cell starting with `= + - @`, tab or CR is prefixed with `'` (formula-injection guard); same guard for import invalid-row reports.
- **Rider-facing responses** (`/rider/*`, rider reads of `/live/*`, and the public `/meta/*`) never include driver names/phones, user ids, internal notes, audit data, other riders' data, or other admin-only fields.
- **No anonymous rider data**: the only unauthenticated endpoints are `GET /meta/*`, `/health`, `/ready` and the auth entry points (captcha, register, login, refresh, forgot/reset password). Stops, routes, timetables, search, trips, live views/streams and nearby buses all require an authenticated user and are filtered to the caller's institution (§6).
- Logs never contain request bodies, `Authorization`/`Cookie` headers, or `access_token` query values (pino-http serializer strips them from URLs).

---

## 5. Authentication & sessions

- `GET /auth/captcha` → `{ captchaId, svg, imageDataUri, expiresAt }` (builtin provider: server-generated SVG text/math challenge, answer stored hashed in `captcha_challenges`, single use, 5-min expiry). `CAPTCHA_PROVIDER=builtin|turnstile|disabled` (`disabled` only allowed outside production; tests use it). For turnstile the client sends `captchaToken`.
- `POST /auth/register` (riders only) `{ fullName, email, phone?, password, joinCode, riderType?, enrolmentNo?, wardName?, captchaId, captchaAnswer }` → `201 { user, accessToken, accessTokenExpiresAt, refreshToken }`. **Join-code onboarding**: in one transaction the code (normalised upper-case) is claimed atomically — `UPDATE institution_join_codes SET uses = uses + 1, updated_at = now() WHERE code = $1 AND is_active AND (expires_at IS NULL OR expires_at > now()) AND (max_uses IS NULL OR uses < max_uses) RETURNING institution_id, campus_id, default_rider_type` (joined to an active institution and, when set, an active campus) — then the `RIDER` user is inserted with that `institution_id` (and `campus_id` as home campus) plus its `rider_profiles` row (`rider_type` = request `riderType` or the code's `default_rider_type`). An unknown, inactive, expired or exhausted code → `VALIDATION_ERROR` on path `joinCode` with one generic message that reveals nothing about any institution; the claim is rolled back if the user insert fails (e.g. `DUPLICATE` email). There is no other self-registration path; admins, drivers and platform admins are provisioned (§6).
- `POST /auth/login` `{ identifier, password, captchaId?, captchaAnswer? }` — identifier matches email, phone or username (drivers use employee code). After 5 consecutive failures for an account the response is `CAPTCHA_REQUIRED` until a valid captcha accompanies the attempt. Returns `{ user, accessToken, accessTokenExpiresAt, refreshToken }` and also sets cookie `wimb_rt` (httpOnly, `SameSite=Lax`, `Secure` in production, `Path=/api/v1/auth`, max-age = refresh TTL). If `mustChangePassword` the user object says so and every non-auth endpoint returns `PASSWORD_CHANGE_REQUIRED` until changed.
- `POST /auth/refresh` — refresh token from body `{ refreshToken }` (mobile) **or** cookie `wimb_rt` (web; cookie mode additionally requires header `X-WIMB-Client: web`). Rotation on every use (`UPDATE … WHERE token_hash=$1 AND revoked_at IS NULL RETURNING` so concurrent refreshes cannot both win). Reuse of a token revoked **more than 10 s ago** revokes the whole family (`UNAUTHENTICATED`); reuse within 10 s (benign multi-tab race) returns `UNAUTHENTICATED` with `details.reason='ROTATED'` without revoking the family.
- `POST /auth/logout` (revoke presented refresh token + clear cookie), `POST /auth/logout-all` (bump `token_version`, revoke all).
- `POST /auth/forgot-password` `{ email, captchaId, captchaAnswer }` → always `200` (no enumeration); emails reset link `${APP_PUBLIC_URL}/reset-password?token=…` via SMTP if configured, otherwise logs the link (dev). Token 30 min, single use, hashed.
- `POST /auth/reset-password` `{ token, newPassword }` → revokes all sessions. `POST /auth/change-password` `{ currentPassword, newPassword }`.
- `GET /auth/me` → `{ user: { id, fullName, email, phone, username, role, mustChangePassword, institutionId, zoneId, campusId, institutionName, zoneName, campusName }, scope, driver?, rider?, permissions: string[] }`; for riders `rider = { riderType, enrolmentNo, wardName, institutionName, institutionType, timezone, campusName, assignedRouteId, assignedRouteCode, assignedRouteName, assignedStopId, assignedStopName }` (one query).
- Password policy: ≥ 8 chars, ≥ 1 letter, ≥ 1 digit. bcrypt cost from `BCRYPT_ROUNDS` (12; tests 4).
- Access JWT claims `{ sub, role, tv }`; middleware verifies then **loads the user row** (`is_active`, `role`, scope ids, `token_version`) — mismatch/inactive → 401.
- Rate limits (per IP + identifier where relevant): login 10/15 min, register 5/hour (also bounds join-code guessing), forgot 5/hour, captcha 30/10 min, refresh 60/15 min; global API 600/min/IP; GPS per-trip throttle (§9).

---

## 6. Roles, scope & permission matrix

Roles (strict order, highest first): `PLATFORM_ADMIN` (operator of the SaaS, all institutions) > `INSTITUTION_ADMIN` (one institution) > `ZONE_ADMIN` (one zone) > `CAMPUS_ADMIN` (one campus) > `DRIVER` (own driver record and trips) and `RIDER` (student, parent/guardian or staff member of one institution). UI labels: Platform admin / Institution admin / Zone admin / Campus admin / Driver / Rider.

Scope object attached as `req.scope` (built per request from the DB user row):
`{ level: 'PLATFORM'|'INSTITUTION'|'ZONE'|'CAMPUS'|'DRIVER'|'RIDER', institutionId, zoneId, campusId, campusIds: uuid[] | null /* null = all */ }` (riders: `institutionId` always set, `campusId` = home campus or null, `campusIds` = every campus of the institution; drivers: their campus).
Helpers: `scope.canAccessCampus(id)`, `scope.canAccessInstitution(id)`, `assertCampusInScope(id)`, `resolveCampusFilter(scope, query)` (turns `zoneId`/`campusId` filters into `campusIds`, `OUT_OF_SCOPE` outside scope), `scopeFilterSql(alias)` / `sqlScopePredicate(campusIds, { column })` that appends the campus/zone/institution predicate, `sqlHierarchyPredicate(scope, { institutionCol, zoneCol, campusCol })` for rows carrying hierarchy columns (users, audit logs). Zone/campus **selectors** in the admin UI just send `zoneId`/`campusId` filters (platform admins also `institutionId`) that must lie inside scope; omitting them = consolidated view of the full scope.

| Capability | CAMPUS_ADMIN | ZONE_ADMIN | INSTITUTION_ADMIN | PLATFORM_ADMIN |
|---|---|---|---|---|
| Read hierarchy (`/admin/hierarchy`) | own campus path | own zone | own institution | all |
| Create/update institutions (type, legal name, contacts, timezone) | – | – | – | ✓ |
| Create/update zones | – | – | in institution | ✓ |
| Create/update campuses (incl. city, `geo_state`, pincode) | – | update in zone | in institution | ✓ |
| Manage admin users | – | CAMPUS_ADMIN in zone | ZONE/CAMPUS_ADMIN in institution | all |
| Join codes (`/admin/join-codes`) | own campus | campuses in zone | institution (incl. institution-wide codes without campus) | all |
| Riders (`/admin/riders`) | riders whose home campus is own campus | riders of campuses in zone | all riders of the institution (incl. those without home campus) | all |
| Platform settings | read | read | read | read/write |
| Read/use stops (search, route building) | institution's stops | institution's stops | institution's stops | all |
| Create stops | ✓ (if `stops.campusAdminCreateEnabled`) | ✓ | ✓ | ✓ |
| Edit/delete non-established stop | own campus's | zone's campuses' | institution's | ✓ |
| Edit/delete established stop | change request only | change request only | ✓ with reason, unless restricted by `stops.institutionAdminEditEnabled` / `stops.institutionAdminDeleteEnabled` | ✓ |
| Review stop change requests | – | – | institution's | ✓ |
| Routes, buses, drivers, imports, schedules, trips | own campus | campuses in zone | campuses in institution | all |
| Admin trip lifecycle (delay/suspend/resume/cancel/complete) | own campus | zone | institution | all |
| Rider & live read endpoints (`/rider/*` reads, `/live/*`) | trips/routes of own campus, institution's stops | zone | institution | all (search/nearby need `institutionId`) |
| Force trip status (correction) | – | – | – | ✓ |
| Audit logs | own campus | zone | institution | all |

User-management guardrails: an admin can only create/modify users whose role is strictly below their own and whose scope lies inside theirs (PLATFORM_ADMIN manages everyone); nobody can change their own role/scope or deactivate themselves; the last active PLATFORM_ADMIN cannot be deactivated or demoted; changing role, scope, `is_active` or password bumps `token_version` and revokes refresh tokens. Driver logins (`role=DRIVER`, `username=employee_code`, `must_change_password=true`) are provisioned only through the drivers module. Rider accounts are created only by join-code registration (§5) and managed through `/admin/riders` (§17); the users module never creates riders and never moves a rider to another institution.

`DRIVER`: only own driver record and own trips (including their live views). `RIDER`: own profile, settings, favorites, recent searches, subscriptions, notifications and my-bus, plus read-only stops, routes, timetables, search, trips, live views/streams and nearby buses **of their own institution only** — results default to the rider's home campus when set; an explicit `campusId` (any campus of the same institution) changes it, one of another institution → `OUT_OF_SCOPE`, and a trip/route/stop id of another institution → 404. Riders never see other riders. **Public (no auth)**: only `GET /meta/*`, `/health`, `/ready` and the auth entry points; there is no anonymous access to any rider data.
Platform setting `scheduling.freeze=true` blocks schedule/trip create/edit for every non-platform admin (`RESTRICTED_BY_SYSTEM`). `gps.ingestionEnabled=false` makes ingestion return `RESTRICTED_BY_SYSTEM`.

**Isolation tests**: every module has cross-institution tests — an admin, driver and rider of institution A can never read, mutate, search, stream or infer institution B data (404 for ids, 403 `OUT_OF_SCOPE` for explicit filters, no B rows in lists, searches, nearby results, duplicate-stop warnings, SSE streams or notifications).

---

## 7. Platform settings (seeded defaults; `platform_settings`)

| key | default | meaning |
|---|---|---|
| `stops.campusAdminCreateEnabled` | `true` | campus admins may create stops |
| `stops.institutionAdminEditEnabled` | `true` | institution admins may edit established stops |
| `stops.institutionAdminDeleteEnabled` | `true` | institution admins may delete/deactivate established stops |
| `stops.duplicateRadiusMeters` | `50` | nearby-duplicate warning radius (stops of the same institution only) |
| `stops.graceEditHours` | `24` | creator campus may edit a non-referenced stop within this window |
| `search.exactRadiusMeters` | `75` | location within this distance of a stop = EXACT |
| `search.nearbyRadiusMeters` | `500` | proximity threshold for LIKELY stops |
| `search.maxCandidateStops` | `6` | max stops considered per From/To |
| `rider.nearbyBusRadiusMeters` | `2000` | nearby-bus default radius |
| `routes.defaultAvgSpeedKmph` | `20` | default planned offsets in route builder |
| `scheduling.maxValidityDays` | `31` | max recurring validity (UI presets 1 / 10 / 15 / 30) |
| `scheduling.freeze` | `false` | platform freeze of scheduling mutations |
| `scheduling.allowCrossCampusResources` | `false` | if true, bus/driver may come from any campus in the route's zone |
| `trips.startWindowBeforeMinutes` | `30` | earliest start relative to planned start |
| `trips.lateStartGraceMinutes` | `120` | latest start relative to planned end |
| `trips.autoDelayGraceMinutes` | `5` | SCHEDULED → DELAYED when not started this long after planned start |
| `trips.autoCancelUnstartedAfterMinutes` | `240` | DELAYED/SCHEDULED never started → CANCELLED this long after planned end (`null` disables) |
| `trips.driverCanSuspend` | `true` | driver may suspend/resume own ACTIVE trip |
| `gps.ingestionEnabled` | `true` | |
| `gps.minIntervalSeconds` | `3` | per-trip ingestion throttle |
| `gps.historySampleSeconds` | `15` | history sampling |
| `gps.historyRetentionDays` | `30` | history retention |
| `gps.freshSeconds` | `30` | LIVE threshold |
| `gps.staleSeconds` | `120` | beyond → STALE |
| `gps.maxAccuracyMeters` | `250` | coarser fixes are stored in history but do not move current state |
| `imports.maxRows` | `5000` | |
| `notifications.approachingMinutes` | `5` | APPROACHING_STOP fires once per trip and stop of interest when the live ETA to that stop first drops to ≤ this value (§12) |

Settings are read through `settingsService.get(key)` (cached 60 s, invalidated on write). Writes are PLATFORM_ADMIN only, validated per key, audited. Settings are platform-wide (they are not per institution).

---

## 8. Trip lifecycle (state machine — single implementation in `trips/lifecycle.service.js`)

| From → To | Who | Notes |
|---|---|---|
| SCHEDULED → DELAYED | driver (own), admin, system worker | `delayMinutes`, `reason`; worker sets it after `autoDelayGraceMinutes` |
| DELAYED → DELAYED | driver (own), admin | update delay minutes/reason (emits TRIP_DELAYED) |
| SCHEDULED/DELAYED → ACTIVE | **assigned driver only** | within start window; driver & bus status ACTIVE; no other ACTIVE trip for driver/bus (unique index); sets `actual_start`, `started_by`, new `gps_session_id`; auto attendance PRESENT |
| ACTIVE → ACTIVE (delay report) | driver (own), admin | updates `delay_minutes`, emits TRIP_DELAYED, status unchanged |
| ACTIVE → COMPLETED | driver (own) or admin (“record completion”, reason) | sets `actual_end`, `completion_source`; GPS stops; live state finalized |
| SCHEDULED/DELAYED/ACTIVE → SUSPENDED | admin; driver for own ACTIVE if `trips.driverCanSuspend` | stores `status_before_suspend`, `suspend_reason`; GPS rejected while suspended |
| SUSPENDED → previous status | admin; driver if they may suspend and previous was ACTIVE | emits TRIP_RESUMED; resuming into ACTIVE fails with `RESOURCE_UNAVAILABLE` if the driver or bus meanwhile has another ACTIVE trip (partial unique indexes are the guard; map their `23505` to this code) |
| SCHEDULED/DELAYED/SUSPENDED/ACTIVE → CANCELLED | admin (reason required); system worker (auto-cancel unstarted) | terminal |
| COMPLETED, CANCELLED | – | terminal |
| any → any | PLATFORM_ADMIN `force-status` | correction, reason mandatory, audited |

Every transition: single transaction → `UPDATE trips … WHERE id=$1 AND status = ANY($allowed) RETURNING *` (0 rows → `INVALID_STATE_TRANSITION` with `details.currentStatus`) → insert `trip_events` → insert `notification_events` (outbox) → audit (admin actions) → commit → emit in-process event `trip.status_changed` → invalidate caches (driver schedule, trip meta, search, dashboard).

---

## 9. Live GPS pipeline (dedicated path `/api/v1/live`)

`POST /live/trips/:tripId/locations` (DRIVER; header `X-Trip-Session: <gpsSessionId>`) body `{ points: [{ lat, lng, recordedAt, accuracy?, speed?, heading? }] }` (1–50 points; batch = offline buffer flush).
1. Trip must be `ACTIVE`, assigned to the caller's driver record, session id must match → else `TRIP_NOT_ACTIVE` (409; body carries `tripStatus` so the client stops transmitting) / 403.
2. Per-trip throttle: one request per `gps.minIntervalSeconds` (burst 3) → else `429 RATE_LIMITED` + `Retry-After`.
3. Points validated: ranges, `recordedAt` ≤ now+60 s and ≥ `actual_start`−60 s; sorted; duplicates ignored.
4. History: sampled to one point per `gps.historySampleSeconds` (bulk insert).
5. Current state: newest point with `recordedAt` newer than stored and accuracy ≤ `gps.maxAccuracyMeters` → project onto route polyline → progress (monotonic; tolerate 100 m jitter backwards), `last_passed_seq`, `next_stop_seq`, `off_route` (> 300 m from polyline) → compute ETA snapshot → upsert `trip_live_state` → update in-memory live store → SSE broadcast (the trip's stream subscribers and the `campus:{campusId}` channel) → APPROACHING_STOP check (§12; only when the ETA snapshot changed).
6. Response `202 { accepted, stored, currentUpdated, tripStatus, serverTime, nextMinIntervalSeconds }`.
No interpolation / dead-reckoning server-side: network loss never fabricates movement.

Freshness (computed at read time from `min(recorded_at, received_at)`): `LIVE` ≤ `gps.freshSeconds`; `RECENT` ≤ `gps.staleSeconds`; `STALE` beyond; `NO_SIGNAL` active but no fix yet; `NOT_LIVE` trip not ACTIVE (never show scheduled trips as live).

### 9.1 Live view DTO (shared by rider web, Flutter, admin)
```json
{
  "tripId": "…", "status": "ACTIVE", "routeId": "…", "routeCode": "WF-P3", "routeName": "Marathahalli – Whitefield Campus (pickup)",
  "direction": "OUTBOUND", "serviceType": "ORDINARY", "bus": { "registrationNo": "KA53AB1234", "fleetNo": "GW-07" },
  "timezone": "Asia/Kolkata", "serviceDate": "2026-10-16",
  "plannedStart": "…Z", "plannedEnd": "…Z", "actualStart": "…Z", "delayMinutes": 0,
  "location": { "lat": 12.96, "lng": 77.70, "headingDeg": 120, "speedKmph": 23, "accuracyM": 12, "recordedAt": "…Z", "ageSeconds": 9 },
  "freshness": "LIVE",
  "progress": { "progressM": 5400, "totalM": 18200, "lastPassedSeq": 4, "nextStopSeq": 5, "offRoute": false },
  "runningLateMinutes": 3,
  "eta": { "computedAt": "…Z", "basis": "LIVE", "stops": [
      { "stopId": "…", "seq": 5, "name": "Kundalahalli Gate", "lat": 12.96, "lng": 77.71,
        "scheduledAt": "…Z", "etaAt": "…Z", "etaMinutes": 6, "passed": false } ] }
}
```
`basis`: `LIVE` (fresh/recent fix), `LAST_KNOWN` (stale: `etaAt`/`etaMinutes` are `null`, show scheduled time + “last seen N min ago”), `SCHEDULE` (not active: scheduled times only).
`GET /rider/trips/:id` additionally returns `stops` (full ordered list with `scheduledAt`) and `polyline: [[lat,lng],…]`.

Read access to every live endpoint (`GET /live/trips/:tripId`, its stream, `GET /live/nearby`) requires authentication: a rider of the trip's institution, an admin whose scope covers the trip's campus, or the trip's assigned driver; any other caller gets 404 for the trip (no existence leak). `GET /live/nearby` returns only ACTIVE trips of the caller's institution (platform admins pass `institutionId`) within `rider.nearbyBusRadiusMeters` by default.
SSE `GET /live/trips/:tripId/stream?access_token=` (authenticated, same institution check): `event: snapshot` (full DTO on connect), `event: location` (location, freshness, progress, runningLateMinutes, eta), `event: status` (`{ tripId, status, delayMinutes, reason, at }`), comment heartbeat every 25 s, `retry: 5000`.
Admin SSE `GET /admin/live/stream?zoneId=&campusId=&access_token=` (channels `campus:{id}` for every campus in the filtered scope): `snapshot` (array of active trips), `location`, `status`.
Notifications SSE `GET /notifications/stream?access_token=` (channel `user:{id}`): `notification`, `unread-count`.
SSE endpoints accept the access token as `access_token` query param (EventSource cannot set headers); token and institution scope checked at connect. Limits: ≤ 10 concurrent streams per user, ≤ 20 per IP for rider trip streams, global cap 5 000; streams are closed when the access token expires (client reconnects with a fresh token). Responses set `Cache-Control: no-cache`, `X-Accel-Buffering: no`; never compressed.

---

## 10. ETA (`eta/eta.service.js`)

Inputs: trip route version stops (`seq`, coordinates, `distance_from_origin_m`, `planned_offset_min`), trip times, live state.
1. Polyline = ordered stop coordinates. Project the fix onto the nearest segment (local equirectangular approximation) → `progressM`, segment index `i`, fraction `f`.
2. Passed stops: `distance_from_origin_m ≤ progressM + 30`.
3. Planned minute at current progress `tPlanNow = offset_i + f·(offset_{i+1} − offset_i)`.
4. For each unpassed stop `k`: `etaAt = fixTime + (offset_k − tPlanNow) minutes` (schedule pace for the remaining distance — operational timing data); `etaMinutes = max(0, ceil((etaAt − now)/60s))`; `etaAt` rounded to the minute. `runningLateMinutes = round((fixTime − actual_start)/60s − tPlanNow)`.
5. Freshness `STALE` → `basis LAST_KNOWN`, no numeric ETA. Not active → `basis SCHEDULE`, `scheduledAt = planned_start + delay_minutes + offset_k`.
6. Snapshot recomputed only on new accepted fix or status change; cached (TTL 30 s) and persisted into `trip_live_state.eta`; reads re-derive `etaMinutes` relative to now from the snapshot (cheap) — never recompute per UI repaint.

---

## 11. Rider search (`rider/search.service.js`, route-first, inside the rider's institution)

All rider endpoints require an authenticated RIDER (admins may call them within their scope) and only ever consider the rider's institution's stops, routes and trips; results default to the rider's campus when set (optional `campusId` inside the institution).

`GET /rider/search?fromStopId|fromQuery|fromLat&fromLng & toStopId|toQuery|toLat&toLng & date=YYYY-MM-DD & after=HH:mm & limit=20`
1. **Resolve From** → candidates `{ stopId, code, name, matchType: EXACT|LIKELY, distanceM }`, max `search.maxCandidateStops`:
   - `fromStopId` → EXACT that stop + ACTIVE stops of the same institution within `search.nearbyRadiusMeters` as LIKELY;
   - `fromQuery` → exact case-insensitive name or code = EXACT; trigram/prefix matches = LIKELY;
   - `fromLat/fromLng` → stops within `search.exactRadiusMeters` = EXACT, within `nearbyRadiusMeters` = LIKELY (bounding box prefilter on `(lat,lng)` index, then haversine).
2. **Candidate routes**: current versions of ACTIVE routes containing any From candidate (`route_stops.stop_id` index) → `(route_id, version_id, from_seq)`.
3. **Resolve To only within those route versions** (same three input modes, restricted to `route_version_id IN candidates` and `seq > from_seq` — direction respected).
4. Best pair per route (EXACT/EXACT first, then smallest distances).
5. **Trips** on candidate routes for `date` (default today in the institution timezone), status in `SCHEDULED, DELAYED, ACTIVE, SUSPENDED, CANCELLED`; offsets taken from each trip's own `route_version_id`; drop trips whose departure from the From stop is already past (unless ACTIVE and the From stop not yet passed); `after` filters departure time.
6. **Rank**: match rank (EXACT·EXACT=0, one LIKELY=1, both LIKELY=2), cancelled last, then departure time.
7. **Compact result** (rider-relevant only; no driver personal data):
```json
{ "query": { "date": "2026-10-16", "timezone": "Asia/Kolkata", "from": [candidates], "to": [candidates] },
  "counts": { "exact": 3, "likely": 2 },
  "results": [ { "tripId", "scheduleId", "routeId", "routeCode", "routeName", "direction", "serviceType",
      "matchType": "EXACT", "from": { "stopId", "name", "seq", "distanceM" }, "to": { … },
      "plannedDeparture", "plannedArrival", "durationMin", "stopsBetween", "status", "delayMinutes",
      "isLive", "freshness", "liveEtaAtFrom": { "etaAt", "etaMinutes" } | null,
      "bus": { "registrationNo", "busType" } } ] }
```
8. Cache: static search payload 30 s keyed by institution + normalized inputs (stop ids, date, lat/lng rounded to 3 dp); `status`, `delayMinutes`, `isLive`, `freshness`, `liveEtaAtFrom` are **overlaid fresh** from the trip-state/live stores on every response. Authenticated searches append to `recent_searches` (keep last 20).

---

## 12. Notifications pipeline

Outbox: lifecycle transitions insert `notification_events` inside the same transaction (`lib/outbox.js#enqueueNotificationEvent(client, {...})`).
Worker (`workers/notification.worker.js`, every 2 s and nudged after commit via the event bus): claims a batch of 50 rows that are `PENDING and available_at <= now()` **or** `PROCESSING and locked_until < now()` using `FOR UPDATE SKIP LOCKED`, setting `status='PROCESSING', locked_until=now()+interval '2 minutes', attempts=attempts+1` → resolves recipients (active `notification_subscriptions` for the trip or its schedule whose `events` contain the type, filtered by rider preference flags; SERVICE_NOTICE → subscribers of the route's schedules + users who favorited the route; STOP_CHANGE_* → state admins / requester) → batch insert `notifications` (`ON CONFLICT (user_id, event_id) WHERE event_id IS NOT NULL DO NOTHING`) → SSE push to `user:{id}` channels → `DONE`; on error `PENDING` with `available_at = now() + 2^attempts seconds`, `FAILED` after 5 attempts.
Templates (title/body): e.g. TRIP_STARTED “Bus 101 has started” / “101 Majestic → Electronic City departed at 08:32. Track it live.”; TRIP_DELAYED “Bus 101 delayed ~15 min” + reason; TRIP_CANCELLED; TRIP_SUSPENDED; TRIP_RESUMED; SERVICE_NOTICE uses admin text. Times rendered in state tz.
Only real driver actions produce TRIP_STARTED — never the clock.

---

## 13. Caching (`lib/cache`)

Interface: `get`, `set(key, value, ttlSec)`, `del(key)`, `wrap(key, ttlSec, loader)` (single-flight), `invalidateNamespace(ns)` (namespace version bump), `stats()`. Keys: `${ns}:v${nsVersion}:${key}`.

| Namespace | TTL | Invalidated by |
|---|---|---|
| `settings` | 60 s | settings write |
| `org` | 10 min | institution/zone/campus write |
| `stops` | 10 min | any stop write / change-request approval |
| `routes` | 10 min | route write / new version (also `routeVersion:{id}` immutable, 1 h) |
| `admin:buses`, `admin:drivers`, `admin:routes`, `admin:stops` | 60 s | writes to that entity (incl. imports) |
| `driverSchedule:{driverId}` | 5 min | any trip/schedule change touching that driver |
| `tripMeta:{tripId}` | 5 min | trip change |
| `search` | 30 s | trip/schedule/route changes (namespace bump) |
| `dashboard` | 15 s | — (short TTL only) |

Never cached: authorization (user row loaded per request), scheduling conflict checks, GPS ingestion decisions. Live state lives in a dedicated in-memory **live store** (mirror of `trip_live_state` for ACTIVE trips; rebuilt from DB on boot) — separate from metadata cache. Rider refreshes never write.

---

## 14. Stops workflow (FRD §4)
- Create: `POST /admin/stops` (name, nameLocal?, lat, lng, classification, landmark?, address?, campusId? (defaults to the caller's campus; required for zone/institution/platform admins), acknowledgeNearby?). If ACTIVE stops of the same institution lie within `stops.duplicateRadiusMeters`, respond `DUPLICATE_STOP` with `details.nearby` unless `acknowledgeNearby=true`. `institution_id` = the creating campus's institution (stops are institution-scoped master data). Map pin is mandatory (coordinates required).
- Established = referenced by any route version **or** older than `stops.graceEditHours`.
- Edit/delete per §6 matrix; established-stop edits/deletes require `reason`, are audited with before/after, and honour system restrictions (`RESTRICTED_BY_SYSTEM`).
- Delete = soft delete (`deleted_at`), only if not used by the current version of any ACTIVE/DRAFT route (`IN_USE` with route list); otherwise deactivate is required first. Stops are never hard-deleted (history).
- Coordinate correction on a referenced stop recomputes `distance_from_origin_m` / route totals for current versions in the same transaction.
- Change requests (campus/zone admins): `POST /admin/stops/:id/change-requests`; the institution's admins approve/reject; approval applies the change transactionally with audit and notifies the requester.

## 15. Routes (FRD §5)
- `POST /admin/routes { depotId, code, name, direction, serviceType, stops:[{stopId, plannedOffsetMin?}], pairRouteId? }` — ≥ 2 distinct ACTIVE stops; distances via haversine; missing offsets derived from `routes.defaultAvgSpeedKmph` (+1 min dwell per intermediate stop); offsets non-decreasing; creates route + version 1; marks stops established.
- `POST /admin/routes/preview` — same body, returns computed distances/offsets/polyline without saving (route builder live preview).
- `PUT /admin/routes/:id/stops { stops, notes, applyToFutureTrips=true }` — creates version n+1; when `applyToFutureTrips`, re-points not-yet-started future trips (`SCHEDULED/DELAYED`, `planned_start > now`) and ACTIVE schedules to the new version; started/finished trips keep their version.
- `POST /admin/routes/:id/reverse { code?, name? }` — creates the opposite-direction variant (stops reversed, offsets recomputed) and links both via `pair_route_id`.
- Deactivate/delete blocked while future non-cancelled trips exist (`IN_USE`).

## 16. Scheduling (FRD §7–8)
- `GET /admin/availability?routeId&serviceDate|validFrom&validTo&daysOfWeek&departureTime&durationMin&excludeScheduleId&excludeTripId` → `{ windows:[{serviceDate, plannedStart, plannedEnd}], buses:[{ id, registrationNo, fleetNo, busType, status, available, reasons:[], conflicts:[…] }], drivers:[{ id, employeeCode, fullName, status, available, reasons:[], conflicts:[…] }] }`. Unavailable reasons: `STATUS_<status>`, `ON_LEAVE` (attendance LEAVE on a window date), `CONFLICT`.
- `POST /admin/schedules/preview` → windows + conflicts without writing.
- `POST /admin/schedules { routeId, busId, driverId, departureTime, durationMin?, validFrom, validTo | validityDays, daysOfWeek, notes?, skipConflictingDates=false }` — transaction: `SELECT … FOR UPDATE` bus + driver rows (deterministic order) → eligibility (status ACTIVE, same campus as the route unless `scheduling.allowCrossCampusResources`, then same zone) → compute windows in the institution timezone (`(service_date + departure_time) AT TIME ZONE tz`) → overlap pre-check (friendly report) → insert schedule + trips + `trip_events(CREATED)` + assignment history → exclusion constraints are the final guard (`23P01` → `SCHEDULE_CONFLICT`) → audit → commit → cache invalidation. Any conflict → 409 with all conflicts and **nothing** created, unless `skipConflictingDates=true` (then response lists skipped dates).
- `PATCH /admin/schedules/:id { busId?, driverId?, departureTime?, durationMin?, validTo?, daysOfWeek?, notes?, version }` — optimistic lock (`STALE_VERSION`); applies to not-started future trips only; extending creates instances, shortening cancels instances beyond; same conflict rules, single transaction.
- `POST /admin/schedules/:id/cancel { reason }` — cancels future not-started trips + schedule; emits SCHEDULE_CANCELLED (+ TRIP_CANCELLED per trip within 48 h).
- One-off trip `POST /admin/trips { routeId, busId, driverId, serviceDate, departureTime, durationMin? }`.
- Per-trip: `PATCH /admin/trips/:id/assignment { busId?, driverId?, reason }`, `PATCH /admin/trips/:id/reschedule { departureTime, durationMin?, reason }` (not-started only, conflict-checked).
- Availability returns when a trip ends: COMPLETED/CANCELLED trips leave the exclusion constraint predicate.

---

## 17. Endpoint catalogue (all under `/api/v1`; owner module in brackets)

**Meta / health** [core] `GET /meta/config` (public: appName, defaultTimezone, freshness thresholds, gps interval, search radii, captchaProvider, turnstileSiteKey, mapTileUrl) · `GET /meta/enums` (public: every enum value list with display labels — roles, trip/bus/driver/stop/route statuses, bus types, fuel types, classifications, directions, service types, document kinds, attendance statuses, notification/event types) · `GET /health` · `GET /ready`

**Auth** [auth] `GET /auth/captcha` · `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/logout-all` · `POST /auth/forgot-password` · `POST /auth/reset-password` · `POST /auth/change-password` · `GET /auth/me`

**Institutions** [institutions] `GET /admin/hierarchy` · `GET|POST /admin/institutions` · `PATCH /admin/institutions/:id` · `GET|POST /admin/zones` · `PATCH /admin/zones/:id` · `GET|POST /admin/campuses` · `GET|PATCH /admin/campuses/:id` · `GET|POST /admin/join-codes` · `PATCH /admin/join-codes/:id`

**Riders & wards** [users] `GET /admin/riders` · `GET|PATCH /admin/riders/:id` · `GET|POST /admin/wards` · `PATCH /admin/wards/:id`

**Users** [users] `GET|POST /admin/users` · `GET|PATCH /admin/users/:id` · `POST /admin/users/:id/reset-password`

**Settings / system** [settings] `GET /admin/settings` · `PUT /admin/settings/:key` · `GET /admin/system/status`

**Audit** [audit] `GET /admin/audit-logs` · `GET /admin/audit-logs/:id`

**Stops** [stops] `GET|POST /admin/stops` · `GET /admin/stops/check-nearby` · `GET|PATCH|DELETE /admin/stops/:id` · `POST /admin/stops/:id/change-requests` · `GET /admin/stop-change-requests` · `GET /admin/stop-change-requests/:id` · `POST /admin/stop-change-requests/:id/approve|reject|cancel`

**Routes** [routes] `GET|POST /admin/routes` · `POST /admin/routes/preview` · `GET|PATCH|DELETE /admin/routes/:id` · `PUT /admin/routes/:id/stops` · `GET /admin/routes/:id/versions` · `GET /admin/routes/:id/versions/:versionId` · `POST /admin/routes/:id/reverse`

**Buses** [buses] `GET|POST /admin/buses` · `GET|PATCH|DELETE /admin/buses/:id` · `GET /admin/buses/:id/trips?when=current|upcoming|past` · `GET|POST /admin/buses/:id/maintenance` · `DELETE /admin/buses/:id/maintenance/:recordId` · `GET|POST /admin/buses/:id/fuel` · `DELETE /admin/buses/:id/fuel/:recordId` · `GET /admin/buses/:id/availability?from&to`

**Drivers** [drivers] `GET|POST /admin/drivers` · `GET|PATCH|DELETE /admin/drivers/:id` · `POST /admin/drivers/:id/login` · `POST /admin/drivers/:id/login/disable` · `GET /admin/drivers/:id/trips?when=` · `GET /admin/drivers/:id/attendance?from&to` · `PUT /admin/drivers/:id/attendance/:date` · `GET /admin/drivers/:id/availability?from&to`

**Imports** [imports] `GET /admin/imports/templates/:type` · `POST /admin/imports/:type` (multipart `file`, `depotId`) · `GET /admin/imports` · `GET /admin/imports/:id` · `GET /admin/imports/:id/rows?status=` · `GET /admin/imports/:id/report` (CSV) · `GET /admin/imports/:id/source` (presigned link to the archived original upload) · `POST /admin/imports/:id/commit { conflictPolicy: SKIP|UPDATE }` · `POST /admin/imports/:id/cancel`

**Documents** [buses, drivers] `GET|POST /admin/drivers/:id/documents` (multipart `file`, `kind`, `validUntil?`, `notes?`) · `PUT /admin/drivers/:id/photo` (image ≤ 2 MB) · `GET|POST /admin/buses/:id/documents` · `DELETE /admin/documents/:docId` · `GET /admin/documents/:docId/download` → `{ url, expiresAt }` (presigned, 5 min). Driver/bus DTOs carry `photoUrl` (presigned) and `documentCount`; document lists flag `expired` / `expiringSoon` from `validUntil`.

**Scheduling** [schedules, trips] `GET /admin/availability` · `POST /admin/schedules/preview` · `GET|POST /admin/schedules` · `GET|PATCH /admin/schedules/:id` · `POST /admin/schedules/:id/cancel` · `GET|POST /admin/trips` · `GET /admin/trips/:id` · `PATCH /admin/trips/:id/assignment` · `PATCH /admin/trips/:id/reschedule` · `POST /admin/trips/:id/delay|suspend|resume|cancel|complete` · `GET /admin/driver-schedules?date&depotId` · `GET /admin/bus-schedules?date&depotId` · `POST /admin/system/trips/:id/force-status`

**Driver** [driver] `GET /driver/me` · `GET /driver/schedule?from&to` · `GET /driver/trips/current` · `GET /driver/trips/:id` · `POST /driver/trips/:id/start|end|delay|suspend|resume` · `GET /driver/history`

**Live** [live] `POST /live/trips/:tripId/locations` · `GET /live/trips/:tripId` · `GET /live/trips/:tripId/stream` · `GET /live/nearby?lat&lng&radiusMeters` · `GET /admin/live/trips?regionId&depotId` · `GET /admin/live/stream` · `GET /admin/trips/:id/track`

**Rider** [rider] (all require an authenticated rider, institution-scoped) `GET /rider/my-bus` · `GET|POST /rider/wards` · `PATCH|DELETE /rider/wards/:id` (guardians) · `GET /rider/stops/search?q&lat&lng&limit` · `GET /rider/stops/nearby?lat&lng&radiusMeters` · `GET /rider/stops/:id` · `GET /rider/search` · `GET /rider/routes/:id` · `GET /rider/routes/:id/timetable?date` · `GET /rider/trips/:id` · `GET|PATCH /rider/profile` · `GET|PUT /rider/settings` · `DELETE /rider/account` · `GET|POST /rider/favorites` · `DELETE /rider/favorites/:id` · `GET|DELETE /rider/recent-searches`

**Notifications** [notifications] `GET /notifications` · `GET /notifications/unread-count` · `POST /notifications/:id/read` · `POST /notifications/read-all` · `GET /notifications/stream` · `GET|POST /notifications/subscriptions` · `PATCH|DELETE /notifications/subscriptions/:id` · `GET|POST /admin/notices` · `GET /admin/events`

**Dashboard** [dashboard] `GET /admin/dashboard?regionId&depotId&date` → `{ scope, kpis:{ activeTrips, tripsToday:{total,scheduled,delayed,active,completed,cancelled,suspended}, onTimePercent, buses:{total,active,maintenance,inactive}, drivers:{total,active,onLeave,onDutyNow}, stops, routes }, alerts:[{type,severity,message,entityType,entityId}], recentEvents:[…], byDepot:[{depotId,depotName,activeTrips,tripsToday,delayed,cancelled}], tripsByHour:[{hour,count}] }` — alert types `STALE_GPS, LONG_DELAY, OVERDUE_ACTIVE, LICENSE_EXPIRING, FITNESS_EXPIRING, INSURANCE_EXPIRING, PENDING_STOP_REQUESTS, BUS_MAINTENANCE_DUE`.

Every module documents exact request/response shapes with examples in `docs/api/<module>.md`.

---

## 18. Backend code structure & patterns

```
backend/
  package.json  .env  .env.example  eslint.config.js  vitest.config.js
  migrations/001_init.sql  (module-specific additive migrations use reserved ranges, see §23)
  scripts/simulate-trips.js            dev GPS simulator (drives seeded trips through the real API)
  src/
    server.js            boot: config → migrate check → http server → workers → graceful shutdown (SIGINT/SIGTERM)
    app.js               createApp(): helmet, cors, cookie-parser, json limit, requestId, pino-http, rate limits,
                         routers (static registry src/modules/index.js), notFound, errorHandler
    config/index.js      zod-validated env
    db/pool.js           pg Pool, query(), withTransaction(fn, {isolation}), row mappers
    db/migrate.js        CLI + programmatic runner (advisory lock, checksum, status)
    db/seed.js           runs src/db/seeds/NN_*.js in order (dev only unless --force)
    lib/                 errors.js, response.js, validate.js, pagination.js, logger.js, cache/, geo.js, time.js,
                         sse.js, events.js (in-process bus), outbox.js, mailer.js, captcha.js, tokens.js, idempotency.js,
                         storage.js (S3/local, §24), uploads.js (multer + magic-byte validation)
    middleware/          requestId, authenticate (required/optional), requireRoles, scope, rateLimits,
                         idempotency, passwordChangeGuard, errorHandler, notFound
    modules/<name>/      router.js (paths + middleware only) → controller.js (thin: read req.valid, call service, send envelope)
                         → service.js (business rules, transactions, audit, cache) → repository.js (SQL only) ; schemas.js (zod)
    workers/             index.js (start/stop), notification.worker.js, tripStatus.worker.js (auto-delay/auto-cancel),
                         maintenance.worker.js (GPS history retention, expired tokens/captcha/idempotency cleanup)
  tests/                 helpers/ (testDb.js, factories.js, auth.js), <module>.test.js
```
Rules: routers contain no business logic; services own transactions; every admin mutation writes `audit_logs` in the same transaction (`auditService.record(client, {...})`); every list endpoint is paginated and scope-filtered in SQL; controllers are async (Express 5 forwards rejections).
In-process event bus events: `trip.status_changed {trip, fromStatus, toStatus, actor}`, `trip.created`, `trip.updated`, `trip.location_updated {tripId, liveView}`, `notification.created {userId, notification}`, `outbox.nudge`.

---

## 19. Frontend (React + Vite) — SAP Fiori design

One SPA, code-split by area, **SAP Horizon** theme via `@ui5/webcomponents-react` `ThemeProvider` (import `@ui5/webcomponents-react/dist/Assets.js`), "72" font, compact density inside the admin console. Look & feel must be indistinguishable from a professional SAP Fiori application: ShellBar, SideNavigation, DynamicPage/ObjectPage floorplans, FilterBar + AnalyticalTable list reports, ObjectStatus semantic colours, MessageStrip/Toast/MessageBox feedback, IllustratedMessage for empty/error states, Wizard for guided creation, BusyIndicator/skeletons for loading.

Areas:
- `/login`, `/register`, `/forgot-password`, `/reset-password` — Fiori sign-in card (shared by all roles; redirect by role).
- **Admin console `/admin/*`**: ShellBar (product “Where Is My Bus · Operations”, scope context selector Institution / Zone / Campus for higher-level admins, notifications bell + count, user menu: profile, change password, sign out). SideNavigation groups: *Overview* (Dashboard, Live Monitor) · *Network* (Stops, Stop Requests, Routes) · *Fleet* (Buses, Drivers, Bulk Import) · *Operations* (Schedules, Trips, Driver Schedules, Bus Schedules) · *Insights* (Operational Events, Notices, Audit Log) · *Administration* (Institutions, Users, Riders, Wards (verification queue), Join codes, Platform Settings [platform admins]).
  Pages: List Report (DynamicPage + FilterBar + AnalyticalTable with server-side sort/filter/pagination toolbar) and Object Page (header KPIs + status, sections/tabs) for every entity; Stop create/edit with Leaflet map pin + nearby-duplicate warning; Route Builder (split: stop search + ordered draggable list + offsets ⇄ live map polyline; preview endpoint); Schedule Wizard (Route → Date/Time & validity presets 1/10/15/30 → eligible Bus & Driver from `/admin/availability` → Review with conflicts → Create with Idempotency-Key); Trip object page with status timeline and admin lifecycle actions; Driver/Bus schedule timeline (day Gantt); Live Monitor (map + freshness-coloured markers + list, SSE); Import (template download → upload → staged report with invalid rows → commit policy); Dashboard (KPI tiles, donut/bar charts via `@ui5/webcomponents-react-charts`, alerts, consolidation table by campus / institution).
- **Rider portal `/rider/*`** (sign-in required; registration with an institution join code): ShellBar + side panel (profile, favorites, notifications, settings, sign out); Home (guardians: "My children" cards — one per ward with its bus, live ETA at the ward's stop, add-child flow with pending verification; students/staff: My bus card for the assigned route/stop; From/To with stop autocomplete, current-location, date, recent searches, nearby-bus action) → Results (Exact vs Likely groups, status/live badges) → Trip live view (map with highlighted route, moving bus marker, per-stop ETA with freshness/last-seen, subscribe & favorite) ; Nearby buses; Favorites; Notifications (SSE); Profile & settings.
- **Driver console `/driver/*`**: today/upcoming schedule, trip detail (stop sequence, start/delay/suspend/end), GPS status panel (permission, last fix, queue, throttle), history.
API client: fetch wrapper, envelope unwrap, typed `ApiError(code, message, details)`, access token in memory, silent refresh via cookie (`credentials: 'include'`, header `X-WIMB-Client: web`), single-flight refresh, React Query for caching/invalidation. Every screen has loading, empty and error states. No secrets in the frontend.

## 20. Mobile app (Flutter, `app/`)

Package `where_is_my_bus`. One app, role-routed after login: **Rider** (student, parent or staff — sign-in required; registration with an institution join code) and **Driver** (login required). Admin roles see “use the web console”.
Fiori-inspired Material 3 theme (Horizon blue `#0070F2`, neutral `#F5F6F7`, semantic positive/critical/negative colours matching UI5).
Rider: home adapts to rider type — guardians: My children (a card per ward: bus, live ETA at the ward's stop, alerts; add child → pending admin verification), students/staff: My bus (assigned route/stop, next trip, live ETA); search inside the institution (stop autocomplete, current location, date, recent searches), results (Exact/Likely), live trip (flutter_map route polyline, bus marker, ETA list with freshness; polling every 5 s while visible), nearby buses, favorites, notifications (polling 30 s + unread badge), profile/settings, register with join code + captcha (SVG via flutter_svg), forgot/reset password, change password, side drawer with logout.
All clients handle `CAPTCHA_REQUIRED` on login (show captcha, resend) and `PASSWORD_CHANGE_REQUIRED` (forced change-password screen, e.g. a driver's first login).
Driver: schedule (today + upcoming), trip detail with stop sequence, start (Idempotency-Key) → GPS service (`geolocator` stream, foreground-service notification on Android, background updates enabled on iOS) batching points, offline queue flushed on reconnect, honours `429 Retry-After` and stops on `TRIP_NOT_ACTIVE`; delay/suspend/resume/end controls; GPS permission/status panel; wakelock during trip; history.
API base URL via `--dart-define=API_BASE_URL=…` (default `http://10.0.2.2:4000` on Android emulator, `http://localhost:4000` elsewhere). Tokens in `flutter_secure_storage`; dio interceptor refreshes on 401 (single-flight).

---

## 21. Testing & quality gates
- Backend: `npm test` (vitest, real Postgres via `TEST_DATABASE_URL`; harness migrates a fresh schema). Mandatory coverage: authentication/session rotation, scope authorization (cross-campus/zone and CROSS-INSTITUTION denial, client-id escalation attempts), stop authority rules + system restrictions, route versioning/history integrity, scheduling conflicts (driver, bus, recurring, concurrent race → exactly one wins, sequential trips allowed), trip lifecycle (no auto-activation, only assigned driver starts, invalid transitions, delay/suspend/resume/cancel/complete), GPS only for ACTIVE + throttle, ETA math, rider search exact/likely/direction inside the institution, imports staging/commit policies/audit, notifications on actual start, idempotency replay.
- Frontend: `npm run build` (tsc + vite) and `npm run lint` clean; key unit tests with vitest.
- Flutter: `flutter analyze` clean, `flutter test` green, `flutter build web` succeeds.
- `npm run seed` gives a fully explorable demo; `node scripts/simulate-trips.js` animates live buses.

## 22. Environment (`backend/.env`)
Precedence: real environment variables > `backend/.env.local` (optional, git-ignored, local overrides) > `backend/.env`.
`DATABASE_URL` / `TEST_DATABASE_URL`, when set, override the discrete `DB_*` values. `backend/.env.example` lists every key with placeholders (never real values).
```
NODE_ENV=development
PORT=4000
CORS_ORIGINS=http://localhost:3000,http://localhost:5173   # comma separated; empty = allow all (dev only)
APP_PUBLIC_URL=http://localhost:5173
TRUST_PROXY=false
DB_HOST=…  DB_PORT=5432  DB_USER=…  DB_PASSWORD=…  DB_NAME=whereismybus  DB_SSL=true  DB_POOL_MAX=10
DB_SSL_REJECT_UNAUTHORIZED=true          # optional; Neon presents publicly trusted certificates
TEST_DB_NAME=whereismybus_test           # same server/credentials; harness refuses DB names without "test"
DATABASE_URL=                            # optional override (connection string)
TEST_DATABASE_URL=                       # optional override for tests
AWS_REGION=in-maa-1  AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…  AWS_BUCKET_NAME=…
S3_PROVIDER=linode  S3_ENDPOINT=https://in-maa-1.linodeobjects.com  S3_KEY_PREFIX=whereismybus/
STORAGE_DRIVER=s3                        # s3 | local (local = backend/storage/, used by tests)
JWT_ACCESS_SECRET=<long random>  ACCESS_TOKEN_TTL=15m  REFRESH_TOKEN_TTL_DAYS=30  BCRYPT_ROUNDS=12
DEFAULT_TIMEZONE=Asia/Kolkata
MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
CAPTCHA_PROVIDER=builtin  TURNSTILE_SITE_KEY=  TURNSTILE_SECRET_KEY=
SMTP_HOST=  SMTP_PORT=587  SMTP_USER=  SMTP_PASS=  MAIL_FROM="Where Is My Bus <no-reply@example.com>"
REDIS_URL=
LOG_LEVEL=info
SEED_DEFAULT_PASSWORD=
```
Secrets are never logged, never returned by any endpoint (system status shows only booleans such as `storageConfigured`), never copied into docs.

## 23. Build ownership (parallel development)
Additional migrations are additive only and use reserved number ranges so parallel work never collides:
`001–099` core/auth/geo/users/settings/audit · `100–149` stops · `150–199` routes · `200–249` buses/drivers · `250–299` imports ·
`300–399` schedules/trips/driver · `400–449` live/GPS · `450–499` ETA · `500–549` rider/favorites · `550–599` notifications · `600–649` dashboard.
Seeds: `src/db/seeds/NN_<module>.js` (same numbering idea: `00_core`, `10_stops`, `15_routes`, `20_fleet`, `30_schedules`, `50_passenger`, `55_notifications`).
Module docs: `docs/api/<module>.md`. Module tests: `tests/<module>*.test.js`.

## 24. File storage (`src/lib/storage.js`)
- Interface: `putObject({ key, body, contentType, checksum })`, `getDownloadUrl(key, { expiresInSec=300, fileName })` (presigned GET with `response-content-disposition`), `deleteObject(key)`, `headObject(key)`, `healthCheck()`.
- Drivers: `s3` (`@aws-sdk/client-s3` with `endpoint=S3_ENDPOINT`, `region=AWS_REGION`, bucket `AWS_BUCKET_NAME`) and `local` (files under `backend/storage/`, download URL served by `GET /api/v1/admin/documents/:docId/download/file?token=…` signed with HMAC, 5 min).
- **Every key starts with `S3_KEY_PREFIX`** (`whereismybus/`): `drivers/{driverId}/{docId}-{safeName}`, `buses/{busId}/{docId}-{safeName}`, `imports/{batchId}/{safeName}`. Objects are private (no public ACL); only presigned URLs are handed out, only to admins whose scope includes the owner's campus.
- Upload validation: size (photos 2 MB, documents 10 MB, imports 5 MB), allow-list by **magic bytes** not just declared MIME (JPEG/PNG/WEBP/PDF for documents; XLSX/CSV for imports), filename sanitised, SHA-256 stored. DB row and object write are coordinated: upload object first, insert row in a transaction, delete the object if the transaction fails; deleting a document soft-deletes the row then removes the object (best effort, logged).
- Imports archive their original spreadsheet (`IMPORT_SOURCE`) for audit (FRD §20).

## 25. Database connectivity rules (Neon / PgBouncer / PG 14–18)
- Production DB is Neon PostgreSQL 18 reached through the **PgBouncer pooler (transaction pooling)**. Therefore: no session-level state outside a transaction (no session `SET`, no `LISTEN/NOTIFY`, no session advisory locks, no temp tables reused across statements). Use `SET LOCAL` inside transactions only.
- The migration runner runs each migration in its own transaction and serialises runners with **`pg_advisory_xact_lock`** (transaction-scoped), re-checking `schema_migrations` after taking the lock. Migrations must not contain statements that cannot run inside a transaction (e.g. `CREATE INDEX CONCURRENTLY`).
- Generated columns must say `STORED` explicitly (PG 18 defaults to `VIRTUAL`, which cannot be indexed or used in exclusion constraints).
- `pg` pool: `connectionTimeoutMillis ≥ 15000` (Neon cold start), `idleTimeoutMillis 30000`, `keepAlive: true`, `ssl` per `DB_SSL`; pool `error` events are logged, never crash the process; transient connection errors (`57P01`, `ECONNRESET`, "Connection terminated") on idempotent reads may be retried once.
- **Round-trip discipline** (the dev machine sees ~270 ms RTT to Neon): no N+1 queries; one query per list endpoint (joins/CTEs for display names and counts); bulk writes as single statements (`INSERT … SELECT generate_series(…)`, `unnest($1::uuid[], …)`, multi-row `VALUES`); recurring schedule creation inserts all trip instances in one statement; seeds are batched. Typical request budget: auth user load + ≤ 3 queries.
- **Type parsing** (set once in `db/pool.js`): `DATE` (OID 1082) stays a `'YYYY-MM-DD'` string (the default JS Date conversion shifts dates by the process timezone, e.g. a day early in IST); `TIME` stays a string (DTOs expose `HH:mm`); `INT8` (OID 20, e.g. `count(*)`) → `Number`; `NUMERIC` (OID 1700) → `Number`; `timestamptz` → `Date`, serialised as ISO UTC.
- Never rely on the session `TimeZone` (it cannot be pinned through the pooler): compute local dates as `(now() AT TIME ZONE $tz)::date`, never `now()::date`/`current_date`; planned instants as `(service_date + departure_time) AT TIME ZONE $tz`.
- Automated tests run against `TEST_DATABASE_URL`/`TEST_DB_NAME` (wiped by the harness); development may point at a local Postgres through `backend/.env.local`.

---

## 26. Deployment domain & nomenclature: private schools, colleges & universities (BINDING — overrides every earlier section)

The platform is operated (SaaS) for **private educational institutions** — schools, colleges, universities and education groups running several campuses — located in **different Indian states**. Each institution owns and runs its own bus fleet for students and staff. **Institutions are isolated tenants**: nobody outside an institution (other institutions, the general public) may see its stops, routes, buses, drivers, trips, live locations, riders or notifications. FRD mechanics (scoped hierarchy, permanent stops, directional routes, conflict-safe schedules, driver-started trips, GPS only for active trips, ETA, notifications, caching) are unchanged. **The nomenclature is institutional everywhere — database, API, roles, code identifiers, docs and UI.**

### 26.1 Rename map (apply to every earlier section, all code, docs and clients)
| FRD / earlier term | New term (DB / API / code) | UI label |
|---|---|---|
| table `states`, State | table `institutions`, Institution | Institution |
| table `regions`, Region | table `zones`, Zone (cluster of campuses inside an institution) | Zone |
| table `depots`, Depot | table `campuses`, Campus (with its transport office / bus depot) | Campus |
| columns `state_id`, `region_id`, `depot_id` (all tables incl. audit_logs) | `institution_id`, `zone_id`, `campus_id` | — |
| `created_by_depot_id`, `requested_by_depot_id` | `created_by_campus_id`, `requested_by_campus_id` | — |
| `passenger_profiles` | `rider_profiles` | — |
| role `SYSTEM_ADMIN` / `STATE_ADMIN` / `REGION_ADMIN` / `DEPOT_ADMIN` / `DRIVER` / `PASSENGER` | `PLATFORM_ADMIN` / `INSTITUTION_ADMIN` / `ZONE_ADMIN` / `CAMPUS_ADMIN` / `DRIVER` / `RIDER` | Platform admin / Institution admin / Zone admin / Campus admin / Driver / Rider (student, parent/guardian, staff) |
| scope levels `SYSTEM/STATE/REGION/DEPOT/DRIVER/PASSENGER` | `PLATFORM/INSTITUTION/ZONE/CAMPUS/DRIVER/RIDER` | — |
| API `/admin/states`, `/admin/regions`, `/admin/depots`, `/admin/geo/tree` | `/admin/institutions`, `/admin/zones`, `/admin/campuses`, `/admin/hierarchy` | — |
| API `/passenger/*` (module `passenger`) | `/rider/*` (module `rider`) | Rider portal |
| query params / DTO fields `stateId`, `regionId`, `depotId`, `stateName`, `regionName`, `depotName`, `depotCode`… | `institutionId`, `zoneId`, `campusId`, `institutionName`, `zoneName`, `campusName`, `campusCode`… | — |
| SSE channels `depot:{id}` | `campus:{id}` | — |
| settings `stops.depotAdminCreateEnabled`, `stops.stateAdminEditEnabled`, `stops.stateAdminDeleteEnabled`, `scheduling.allowCrossDepotResources`, `passenger.nearbyBusRadiusMeters` | `stops.campusAdminCreateEnabled`, `stops.institutionAdminEditEnabled`, `stops.institutionAdminDeleteEnabled`, `scheduling.allowCrossCampusResources`, `rider.nearbyBusRadiusMeters` | — |
| "state timezone" | institution timezone (`institutions.timezone`, default `Asia/Kolkata`) | — |
| route direction `OUTBOUND` / `INBOUND` | unchanged values | **To campus (pickup)** / **From campus (drop)** |
| stops | unchanged (`stops`, institution-scoped) | Stop (riders: "pickup stop") |
Module folders: `geo` → `institutions`, `passenger` → `rider`. Words like "trip state", "live state", "state machine" are NOT part of the rename.

### 26.2 Schema additions
- `institutions`: `institution_type text not null default 'SCHOOL' check in ('SCHOOL','COLLEGE','UNIVERSITY','GROUP')`, `legal_name text`, `contact_email citext`, `contact_phone text`, `website text`, `address text`.
- `campuses`: `city text`, `geo_state text` (Indian state/UT where the campus is, e.g. "Telangana"), `pincode text`.
- `users`: `RIDER` requires **`institution_id NOT NULL`**; `campus_id` optional (home campus; zone/institution derived by the hierarchy triggers).
- `rider_profiles`: `rider_type text check in ('STUDENT','PARENT','STAFF','OTHER')`, `enrolment_no text`, `assigned_route_id → routes`, `assigned_stop_id → stops` (students/staff; validated: same institution; stop on the route's current version). Guardians' children live in `rider_wards` (§26.4).
- `institution_join_codes(id, institution_id → institutions not null, campus_id → campuses null, code text unique not null (8–12 upper-case alphanumerics), default_rider_type text, max_uses int, uses int not null default 0, expires_at timestamptz, is_active bool not null default true, created_by → users, created_at, updated_at)`.
- Notification vocabulary adds **`APPROACHING_STOP`**; setting `notifications.approachingMinutes` (default `5`): riders subscribed with a stop of interest get one APPROACHING_STOP per trip when the live ETA to that stop first drops to ≤ this value.

### 26.3 Access rules (replace the "public passenger" rules of §6, §9, §11, §17)
- **No anonymous access** to rider search, stops, routes, timetables, trips, live views, live streams or nearby buses. Public: only `GET /meta/*`, `/health`, `/ready` and auth (captcha, register, login, refresh, forgot/reset).
- A rider sees **only their institution's** network and trips; results default to the rider's campus when set (optional `campusId` filter inside the institution). Admins may use rider/live read endpoints within their scope. Drivers see only their own trips.
- Live SSE streams authenticate with the `access_token` query parameter and apply the same institution check.
- **Stops are institution-scoped**: non-platform admins read/use only their institution's stops; authority over established stops = the **Institution admin**; change requests are reviewed by that institution's admins.
- Every module has **cross-institution isolation tests** (admin, driver and rider of institution A can never read, mutate, search, stream or infer institution B data — 404 for ids, 403 `OUT_OF_SCOPE` for explicit filters).

### 26.4 Rider onboarding, guardians & wards, management
- **Rider types**: `STUDENT`, `PARENT` (guardian), `STAFF`, `OTHER`. One rider app serves all of them; its home adapts to the type: guardians see a card per child ("My children"), students/staff see "My bus".
- `POST /auth/register` requires `joinCode` (+ captcha): active, unexpired, below `max_uses` (atomic increment) → rider linked to the code's institution (and campus); `riderType` from the request or the code default. Invalid code → `VALIDATION_ERROR` on `joinCode` revealing nothing about other institutions.
- **Students/staff assignment**: `rider_profiles.assigned_route_id/assigned_stop_id` (set by admins; validated: same institution, stop on the route's current version).
- **Guardians & wards** (siblings may ride different buses): table `rider_wards(id, guardian_user_id → users (RIDER/PARENT) on delete cascade, institution_id → institutions not null (= guardian's), campus_id → campuses not null (same institution), ward_name text not null, ward_class text, enrolment_no text, student_user_id → users null (optional link to the child's own STUDENT account), assigned_route_id → routes null, assigned_stop_id → stops null, status text not null default 'PENDING' check in ('PENDING','VERIFIED','REJECTED','INACTIVE'), review_note text, verified_by → users, verified_at, created_at, updated_at)`; unique (guardian_user_id, enrolment_no) where enrolment_no is not null.
  - Guardian (rider API): `GET /rider/wards`, `POST /rider/wards { wardName, wardClass?, enrolmentNo?, campusId }` → PENDING, `PATCH /rider/wards/:id` (only while PENDING), `DELETE /rider/wards/:id`.
  - Admin: `GET /admin/wards` (scope; filters status, campus, route, q; csv), `POST /admin/wards` (create for a guardian, may be VERIFIED directly), `PATCH /admin/wards/:id` (verify/reject with note, assign route & stop, link student account, deactivate) — audited; module `users`.
- **Assignment-based notifications** (no manual subscription needed): for trip events (TRIP_STARTED/DELAYED/CANCELLED/SUSPENDED/RESUMED) the recipients also include students/staff assigned to the trip's route and guardians with a VERIFIED ward assigned to that route (respecting their preference flags); APPROACHING_STOP is sent once per trip to each such rider for their assigned stop (guardians: the ward's stop) and to explicit subscribers with a stop of interest. Guardian messages name the child ("Aarav's bus R03 (To campus) is about 5 min from Hope Farm").
- Join codes: `GET|POST /admin/join-codes`, `PATCH /admin/join-codes/:id` (deactivate, expiry, max uses) — campus admins for their campus, zone/institution admins within scope, platform admins all; audited (module `institutions`).
- Riders admin: `GET /admin/riders` (scope; filters campus, riderType, assignedRouteId, q, isActive; csv; guardians show ward counts), `GET /admin/riders/:id` (incl. wards), `PATCH /admin/riders/:id` (campus within the institution, riderType, enrolmentNo, assignedRouteId/assignedStopId, isActive — deactivation revokes sessions); audited (module `users`).
- `GET /rider/my-bus`: students/staff → their assignment; guardians → one entry per VERIFIED ward (ward name/class + assignment); each entry carries today's and next trips of the assigned route at the assigned stop with planned time, status and live ETA/freshness overlay; pending wards are listed with their status.
- `GET /auth/me` for riders includes institution, campus, rider type, own assignment names and (guardians) ward summaries.

### 26.5 Terminology & clients
`GET /meta/config` returns `labels` (institution, zone, campus, stop, rider, role labels, direction labels) and `/meta/enums` carries the same labels. Web and mobile never show "State/Region/Depot/Passenger". The rider web portal and the rider mobile experience require sign-in (register with a join code). The admin console's "Organisation" page is **Institutions** (institutions → zones → campuses with type/contact/location fields); the Administration group gains **Riders** and **Join codes**.

### 26.6 Demo data (fictional institutions, real localities, different states)
| Institution (code, type) | Zones → Campuses (city, state) |
|---|---|
| Greenwood International School (GWIS, SCHOOL) | Main zone → Whitefield Campus (Bengaluru, Karnataka), Sarjapur Campus (Bengaluru, Karnataka) |
| Horizon University (HZU, UNIVERSITY) | South zone → Hyderabad Campus (Telangana), Chennai Campus (Tamil Nadu); West zone → Pune Campus (Maharashtra) |
| Riverside College of Arts & Science (RCAS, COLLEGE) | Main zone → Kakkanad Campus (Kochi, Kerala) |
| Sunrise Public School (SPS, SCHOOL) | Main zone → Malviya Nagar Campus (Jaipur, Rajasthan) |
Each campus: realistic stops in surrounding localities; 3–6 routes as To-campus / From-campus pairs (Horizon University also a campus **shuttle loop** running all day so live demos work at any hour); 6–12 buses with state-appropriate registrations (KA, TS, TN, MH, KL, RJ); drivers with regionally appropriate names and logins; schedules with institution timings (schools: morning pickups ~06:45–08:15 and afternoon drops ~14:00–16:30, Mon–Sat; colleges/universities Mon–Fri with several shifts; university shuttle every 30–45 min 07:30–20:00); one join code per campus; demo admins for every level; demo riders (a Greenwood guardian with two children — one VERIFIED ward with route/stop, one PENDING —, a Horizon student with an assignment, a Riverside staff member). Every demo account, password and join code is listed in `docs/SEED_DATA.md`.
