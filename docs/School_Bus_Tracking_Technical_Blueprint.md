# School Bus Tracking & Fleet Management Platform
## Detailed Technical Blueprint (derived from client FRD v1.0)

**Stack:** Node.js + Express + PostgreSQL (backend) · React + Vite (web admin panels) · Flutter (Driver app, Parent app)
**Model:** Multi-tenant SaaS. We (the vendor) own the platform; each school is a tenant.

---

## Table of Contents

1. [Product Understanding](#1-product-understanding)
2. [Actors, Roles and Permission Matrix](#2-actors-roles-and-permission-matrix)
3. [System Architecture](#3-system-architecture)
4. [Multi-Tenancy Design](#4-multi-tenancy-design)
5. [Authentication and Authorization](#5-authentication-and-authorization)
6. [Database Design](#6-database-design)
7. [Backend (Node/Express) Design](#7-backend-nodeexpress-design)
8. [API Catalogue](#8-api-catalogue)
9. [Live Tracking Engine](#9-live-tracking-engine)
10. [Trip Lifecycle and Odometer Validation](#10-trip-lifecycle-and-odometer-validation)
11. [Alerts and Notifications Engine](#11-alerts-and-notifications-engine)
12. [File and Document Storage](#12-file-and-document-storage)
13. [Web Admin Panel (React + Vite)](#13-web-admin-panel-react--vite)
14. [Driver / Conductor App (Flutter)](#14-driverconductor-app-flutter)
15. [Parent App (Flutter)](#15-parent-app-flutter)
16. [Security, Privacy and Compliance](#16-security-privacy-and-compliance)
17. [DevOps, Deployment and Observability](#17-devops-deployment-and-observability)
18. [Delivery Plan (Phases)](#18-delivery-plan-phases)
19. [Gaps in the FRD and Questions for the Client](#19-gaps-in-the-frd-and-questions-for-the-client)
20. [Recommended Additions for Us as a Vendor](#20-recommended-additions-for-us-as-a-vendor)

---

## 1. Product Understanding

The client FRD describes a **multi-tenant school transport platform**. Core ideas:

- **No GPS hardware.** The driver's phone is the tracker, and it tracks **only during an active trip**.
- **Odometer-photo evidence** at trip start and end is mandatory. It is used to detect unrecorded or personal use of school vehicles.
- **Parents** get a read-only, Ola/Uber-style live map of *their child's* bus, plus bus/driver/conductor details that the school chooses to expose.
- **School Admin** runs the whole fleet: buses, routes, stops, staff, students, parents, documents, fuel, maintenance, alerts, reports.
- **Platform Owner (us)** only creates and manages *school tenants* and global settings. We must **not** touch a school's operational data.
- **Hard isolation:** School A can never reach School B's data through UI, API, files, search, reports or direct links.

### Deliverables

| # | Deliverable | Tech | Users |
|---|---|---|---|
| 1 | **Super Admin Panel** (platform console) | React + Vite | Us only |
| 2 | **School Admin Panel** | React + Vite (same codebase, different route tree) | School staff admins |
| 3 | **Driver/Conductor App** | Flutter | Drivers, conductors |
| 4 | **Parent App** | Flutter | Parents |
| 5 | **Backend API + realtime + jobs** | Node/Express, PostgreSQL, Redis | All of the above |

---

## 2. Actors, Roles and Permission Matrix

### 2.1 Roles

| Role | Scope | Created by | Logs into |
|---|---|---|---|
| `super_admin` | Platform (no school) | Seeded / us | Web panel `/platform` |
| `school_admin` | One school | Super Admin (first admin), then other school admins | Web panel `/school` |
| `driver` | One school, own assignments only | School Admin | Driver app |
| `conductor` | One school, own assignments only | School Admin | Driver app |
| `parent` | One or more schools, own children only | School Admin (or CSV import) | Parent app |

### 2.2 Permission matrix

| Capability | Super Admin | School Admin | Driver/Conductor | Parent |
|---|:-:|:-:|:-:|:-:|
| Create/edit/deactivate/soft-delete schools | ✅ | ❌ | ❌ | ❌ |
| Create initial school admin; reset its password | ✅ | ❌ | ❌ | ❌ |
| Global settings (default intervals, expiry thresholds) | ✅ | ❌ | ❌ | ❌ |
| Tenant status and aggregate health counts | ✅ | ❌ | ❌ | ❌ |
| Buses, routes, stops, students, parents, staff CRUD | ❌ | ✅ (own school) | ❌ | ❌ |
| Documents upload/replace/visibility | ❌ | ✅ | ❌ | ❌ |
| Assign students/staff to bus/route/stop | ❌ | ✅ | ❌ | ❌ |
| School-level settings and parent visibility | ❌ | ✅ | ❌ | ❌ |
| Live fleet map, trip history, alerts, fuel, maintenance, reports | ❌ | ✅ | ❌ | ❌ |
| View own assigned buses/routes/schedule | ❌ | ✅ | ✅ | ❌ |
| Start/end trip, odometer evidence, send location | ❌ | ❌ | ✅ | ❌ |
| Log non-school trip (if school allows) | ❌ | ❌ | ✅ | ❌ |
| View live bus for own child, ETA, bus/staff details | ❌ | ❌ | ❌ | ✅ (read-only, per visibility) |
| Notification preferences per child and trip type | ❌ | ❌ | ❌ | ✅ |

> **Design consequence:** Super Admin never receives school-scoped rows. This is enforced in the database (RLS), not only in code. See §4.

---

## 3. System Architecture

### 3.1 High-level diagram

```
                         ┌────────────────────────────┐
                         │  Web Admin (React + Vite)  │
                         │  /platform  (Super Admin)  │
                         │  /school    (School Admin) │
                         └──────────────┬─────────────┘
                                        │ HTTPS (REST) + WSS
┌──────────────────┐                    │                   ┌──────────────────┐
│ Driver App       │ HTTPS (REST)       │                   │ Parent App       │
│ (Flutter)        ├────────────────────┤                   │ (Flutter)        │
│ GPS + odometer   │                    │                   │ Map + details    │
└──────────────────┘                    │                   └────────┬─────────┘
                                        │  REST + WSS / FCM push     │
                              ┌─────────▼──────────┐                 │
                              │  Nginx / LB (TLS)  │◄────────────────┘
                              └─────────┬──────────┘
                    ┌───────────────────┼────────────────────┐
          ┌─────────▼────────┐ ┌────────▼────────┐ ┌─────────▼────────┐
          │ API (Express)    │ │ Realtime        │ │ Worker (BullMQ)  │
          │ REST, auth, RBAC │ │ Socket.IO       │ │ alerts, ETA,     │
          │ tenant context   │ │ (parent/admin   │ │ notifications,   │
          │                  │ │  live maps)     │ │ cron jobs        │
          └────────┬─────────┘ └────────┬────────┘ └─────────┬────────┘
                   │                    │                    │
          ┌────────▼────────────────────▼────────────────────▼───────┐
          │                  Redis                                    │
          │  live position cache · pub/sub · BullMQ queues · rate     │
          │  limits · OTP/session blacklist                           │
          └───────────────────────────────────────────────────────────┘
                   │
          ┌────────▼───────────────────┐     ┌───────────────────────────┐
          │ PostgreSQL (+ PostGIS)     │     │ Private Object Storage    │
          │ shared DB, school_id + RLS │     │ (S3 / R2 / MinIO)         │
          │ partitioned location_points│     │ prefix: schools/{id}/...  │
          └────────────────────────────┘     └───────────────────────────┘

External: Firebase Cloud Messaging (push), Maps/Routing provider, SMS/OTP provider,
          Sentry (errors), optional WhatsApp/SMS notification module.
```

### 3.2 Technology choices

| Concern | Choice | Reason |
|---|---|---|
| Language | **TypeScript** on backend and web | Shared types, fewer runtime bugs |
| API | Express 4/5 + **Zod** validation | Matches your stack; schemas double as docs |
| DB | PostgreSQL 15+ with **PostGIS** | Geofence radius, route deviation, distance on the path |
| DB access | **Drizzle ORM** or **Knex** + raw SQL for geo | Need explicit transactions to set the tenant context for RLS. Prisma makes per-transaction `SET LOCAL` awkward. |
| Cache/queue | **Redis** + **BullMQ** | Live position cache, pub/sub, background jobs |
| Realtime | **Socket.IO** (Redis adapter) | Rooms per trip. Falls back to polling. Scales horizontally. |
| Push | **FCM** (via `firebase-admin`) | Android + iOS |
| Files | S3-compatible private bucket | Signed URLs, tenant prefixes |
| Auth | JWT access (15 min) + rotating refresh tokens, **argon2id** hashing | |
| Web UI | React 18 + Vite + TypeScript, React Router, TanStack Query, Zustand, React Hook Form + Zod, **MUI or shadcn/ui**, TanStack Table | |
| Web maps | Google Maps JS **or** Leaflet + OSM tiles | Cost decision (see §19) |
| Mobile | Flutter 3.x, **Riverpod**, go_router, dio, freezed/json_serializable | |
| Monorepo | **pnpm workspaces** (backend + web + shared types) and **melos** (Flutter apps + shared Dart package) | Keep contracts aligned |

### 3.3 Suggested repository layout

```
school-bus-platform/
├── apps/
│   ├── api/                      # Express app (REST + Socket.IO)
│   ├── worker/                   # BullMQ workers + cron schedulers
│   └── web/                      # React + Vite (platform + school panels)
├── packages/
│   ├── shared-types/             # Zod schemas, enums, API DTOs (TS)
│   └── eslint-config/
├── mobile/
│   ├── packages/
│   │   ├── core/                 # API client, auth, models, theme, utils
│   │   └── map_kit/              # shared map widgets, polyline, marker anim
│   ├── driver_app/
│   └── parent_app/
├── infra/
│   ├── docker/  nginx/  terraform-or-compose/
│   └── db/migrations/            # SQL migrations (source of truth)
└── docs/
```

---

## 4. Multi-Tenancy Design

### 4.1 Strategy: shared database, shared schema, `school_id` on every tenant row, enforced by Row-Level Security

This follows the FRD (shared PostgreSQL first, migration to a dedicated DB later).

**Three layers of defence (all three are required):**

1. **API layer:** `school_id` is taken **only from the verified JWT** (or, for parents, from a validated header). It is never read from the request body or URL for authorization.
2. **Data access layer:** every query runs inside a transaction that first sets the tenant context.
3. **Database layer (RLS):** policies reject any row whose `school_id` differs from the session's tenant. A forgotten `WHERE school_id = ...` cannot leak data.

### 4.2 How tenant context reaches Postgres

```ts
// db/withTenant.ts
export async function withTenant<T>(ctx: TenantCtx, fn: (tx: Tx) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.school_id',   ${ctx.schoolId ?? ''}, true)`);
    await tx.execute(sql`SELECT set_config('app.actor_id',    ${ctx.actorId},        true)`);
    await tx.execute(sql`SELECT set_config('app.actor_role',  ${ctx.role},           true)`);
    return fn(tx);                    // `true` = local to this transaction
  });
}
```

Express middleware chain for school-scoped routes:

```
authenticate (JWT) → resolveTenant (school active? not suspended?) → authorize(role) → handler uses withTenant(req.ctx, ...)
```

### 4.3 RLS policy pattern

```sql
-- App connects as role `app_user` (NOT table owner, NOT superuser, NO BYPASSRLS)
ALTER TABLE buses ENABLE ROW LEVEL SECURITY;
ALTER TABLE buses FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON buses
  USING      (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid);
```

Apply the same policy to **every** tenant table. Generate it in a migration helper so no table is forgotten, and add a **CI test** that fails if any table with a `school_id` column lacks RLS.

Extra policies for narrower roles (defence in depth):

```sql
-- Parents can only read students linked to them
CREATE POLICY parent_students_only ON students FOR SELECT
  USING (
    current_setting('app.actor_role', true) <> 'parent'
    OR id IN (SELECT student_id FROM student_parents
              WHERE parent_account_id = current_setting('app.actor_id', true)::uuid)
  );
```

### 4.4 Super Admin and the "must not manage school data" rule

- Super Admin requests run **without** an `app.school_id`, so RLS returns **zero rows** from every tenant table. The restriction is structural.
- Super Admin works only with `schools`, `platform_users`, `platform_settings` (non-tenant tables).
- "Platform health" aggregates (active trips, bus counts, last-activity) come from **`SECURITY DEFINER` SQL functions** that return counts only, never rows.
- Super Admin can reset the **school admin's** credentials (explicitly allowed). There is **no impersonation** feature by default.

### 4.5 Pre-authentication lookups

Login happens before the tenant is known. Use a small set of `SECURITY DEFINER` functions (e.g., `auth_find_user_for_login(...)`) that return only the minimal columns needed (id, school_id, role, password_hash, is_active). No general bypass role.

### 4.6 Parent across multiple schools

- Parent identity is **global** (`parent_accounts`, unique by mobile number) because one parent may have children in different schools.
- Everything else is per school: `school_parents` (name/email as known to that school), `student_parents` (links, with `school_id`).
- After login, the app calls `GET /parent/children`. The server returns **cards grouped by school**. Every subsequent call carries `X-School-Id`. The server validates that the parent has an active link in that school and then sets the tenant context to that school.

### 4.7 Future migration of a large school to a dedicated DB/server

Design for this now, so it costs nothing later:

```sql
schools(
  id, ...,
  tenant_mode      text DEFAULT 'shared',      -- 'shared' | 'dedicated'
  db_connection_ref text NULL,                  -- key into secrets manager
  storage_prefix   text,                        -- or dedicated bucket
  realtime_shard   text NULL
)
```

- `resolveTenant` returns a **connection pool for that tenant**. Shared tenants share one pool; dedicated tenants get their own.
- Never hard-code the global pool inside repositories. Always call `getPool(tenant)`.
- All primary keys are **UUIDs** (v7 preferred), so rows can be exported/imported without ID collisions.
- Per-school export script (`pg_dump` with `WHERE school_id = ...` via COPY) lives in `infra/`.
- Users, parents and staff must not be keyed by anything global except `parent_accounts`. For dedicated schools, keep a lightweight global **routing table** (`phone → school_ids`) in the platform DB so parent login still works.

### 4.8 Files

Object key format: `schools/{school_id}/{category}/{entity_id}/{uuid}.{ext}`. Files are never public. Every download goes through the API (authorize → short-lived signed URL). See §12.

### 4.9 Tenant isolation test suite (mandatory)

Automated tests run in CI:

- Create School A and B with identical codes (`R1`, `Stop 1`, same names). Verify no cross-reads on **every** endpoint.
- Call each endpoint with A's token but B's IDs → expect `404`.
- Try mass-assignment of `school_id` in bodies → ignored.
- Parent with children in A and B: switch `X-School-Id`, verify filtering.
- Direct SQL as `app_user` without context → zero rows.
- Signed URL for A's file used on B's session → denied.
- Socket.IO: join B's trip room with A's token → rejected.

---

## 5. Authentication and Authorization

### 5.1 Login methods

| User | Identifier | Credential | Notes |
|---|---|---|---|
| Super Admin | email | password + **TOTP 2FA (recommended)** | Separate login screen/route |
| School Admin | email (globally unique) | password | Optional 2FA later |
| Driver/Conductor | **school code + mobile/username** | password or 4–6 digit PIN | School code avoids collisions across tenants. Created by School Admin. |
| Parent | mobile number | **OTP** (SMS) | Single login across schools. Optional password fallback. |

### 5.2 Tokens and sessions

- Access token: JWT, 15 min. Claims: `sub`, `role`, `school_id` (null for super admin and parents), `sid` (session id).
- Refresh token: opaque, random, **hashed in DB**, rotated on every use, reuse detection revokes the whole session family.
- `sessions` table stores device id, platform, app version, last seen. Admin can force-logout a user. Deactivating a user revokes all sessions.
- Driver app tokens are **bound to a registered device** (`devices` table). Location submissions from an unregistered device are rejected (FRD §9.1).

### 5.3 Authorization layers

1. Route guard by role (`authorize('school_admin')`).
2. Ownership checks (a driver can only act on trips assigned to them; a parent only on their linked students).
3. RLS as the final backstop.
4. Permission codes for school admins are optional later (e.g., `school_admin` vs `school_viewer`).

### 5.4 Password and account rules

- argon2id hashing; minimum policy enforced on web; rate-limited login (per IP and per identifier); lock after N failures with a cooldown.
- School Admin can reset driver/conductor/parent access. Generates a temporary password or sends an OTP. Forces a change on next login.
- Deactivation **never deletes**. It sets `is_active=false`, revokes sessions and keeps history.

---

## 6. Database Design

Conventions: UUID PKs, `school_id` on every tenant table, `created_at/updated_at/created_by`, soft delete via `deleted_at` where history matters, `citext` for emails, enums as `text + CHECK` (easier to migrate than native enums), all timestamps `timestamptz` (stored UTC; each school has an IANA timezone for display and scheduling).

### 6.1 Entity relationship overview

```
schools 1─┬─* users (school_admin, driver, conductor)
          ├─* staff_profiles 1─* staff_documents
          ├─* buses 1─┬─* bus_documents
          │           ├─* bus_staff_assignments (history)
          │           └─* bus_route_assignments (history)
          ├─* routes 1─* stops
          ├─* trip_schedules (bus + route + direction + time + days)
          ├─* trips 1─┬─* location_points (partitioned)
          │           ├─* trip_stop_events
          │           └─* trip_odometer_evidence
          ├─* students ─* student_parents *─ parent_accounts (global)
          │       └─* student_assignments (history: bus/route/stop)
          ├─* alerts · fuel_logs · maintenance_logs · audit_logs
          ├─* notification_preferences · notification_events
          └─* school_settings (1:1)
```

### 6.2 Core DDL (abridged but implementable)

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────── PLATFORM (non-tenant) ─────────────
CREATE TABLE platform_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  totp_secret_enc text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,               -- short login code e.g. 'DPS-GZB'
  name text NOT NULL,
  address text, city text, state text, pincode text,
  contact_name text, contact_phone text, contact_email text,
  logo_key text,
  latitude numeric(9,6), longitude numeric(9,6),   -- school location for maps
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','suspended','inactive')),
  tenant_mode text NOT NULL DEFAULT 'shared',
  db_connection_ref text, storage_prefix text,
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

CREATE TABLE platform_settings (       -- global defaults
  key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now()
);
-- e.g. location.moving_interval_s=10, location.stopped_interval_s=90,
--      location.moving_speed_kmh=4, location.stopped_after_s=60,
--      docs.expiry_reminder_days=[60,30,15,7,1]

-- ───────────── SCHOOL SETTINGS (overrides + visibility) ─────────────
CREATE TABLE school_settings (
  school_id uuid PRIMARY KEY REFERENCES schools(id),
  location_moving_interval_s int,            -- NULL = use platform default
  location_stopped_interval_s int,
  moving_speed_kmh numeric(4,1),
  allow_non_school_trips boolean DEFAULT false,
  odometer_gallery_allowed boolean DEFAULT false,
  odometer_mismatch_threshold_km numeric(6,1) DEFAULT 5,
  odometer_gps_variance_pct numeric(5,2) DEFAULT 15,
  trip_not_started_grace_min int DEFAULT 10,
  stop_duration_alert_min int DEFAULT 10,
  speed_limit_kmh int,
  enable_speeding_alert boolean DEFAULT false,
  enable_harsh_driving_alert boolean DEFAULT false,
  enable_route_deviation_alert boolean DEFAULT false,
  route_deviation_m int DEFAULT 300,
  approaching_stop_minutes int DEFAULT 5,
  alert_recipients jsonb DEFAULT '[]',
  parent_visibility jsonb NOT NULL DEFAULT '{
    "bus":   {"capacity":false,"images":true,"plate":true,
              "insurance_status":true,"insurance_file":false,
              "fitness_status":true,"fitness_file":false},
    "driver":{"photo":true,"phone":false,"email":false,"experience":true,
              "licence_validity":true,"licence_file":false,
              "training":true,"character_cert_status":true,"verification":true},
    "conductor":{"photo":true,"phone":false,"email":false,"experience":true,
              "verification":true,"character_cert_status":true,"training":true}
  }',
  updated_at timestamptz DEFAULT now()
);

-- ───────────── USERS (school-scoped logins) ─────────────
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  role text NOT NULL CHECK (role IN ('school_admin','driver','conductor')),
  full_name text NOT NULL,
  email citext, phone text, username text,
  password_hash text NOT NULL,
  must_change_password boolean DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  deleted_at timestamptz,
  created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
-- school admins: global-unique email; drivers/conductors: unique per school
CREATE UNIQUE INDEX users_admin_email_uq ON users(email) WHERE role='school_admin' AND deleted_at IS NULL;
CREATE UNIQUE INDEX users_staff_phone_uq ON users(school_id, phone) WHERE role IN ('driver','conductor') AND deleted_at IS NULL;

-- ───────────── PARENTS (global identity + per-school profile) ─────────────
CREATE TABLE parent_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text UNIQUE NOT NULL,            -- E.164
  password_hash text,                    -- optional
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE school_parents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  parent_account_id uuid NOT NULL REFERENCES parent_accounts(id),
  full_name text NOT NULL, email citext, relation text,
  is_active boolean DEFAULT true, deleted_at timestamptz,
  UNIQUE (school_id, parent_account_id)
);

CREATE TABLE students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  admission_no text, full_name text NOT NULL,
  class_name text, section text, photo_key text,
  is_active boolean DEFAULT true, deleted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE (school_id, admission_no)
);

CREATE TABLE student_parents (
  school_id uuid NOT NULL REFERENCES schools(id),
  student_id uuid NOT NULL REFERENCES students(id),
  parent_account_id uuid NOT NULL REFERENCES parent_accounts(id),
  is_primary boolean DEFAULT false,
  PRIMARY KEY (student_id, parent_account_id)
);

-- ───────────── FLEET ─────────────
CREATE TABLE buses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  code text NOT NULL,                       -- 'R1', 'S1', 'Green Van' (parent-visible)
  display_name text, vehicle_type text, capacity int,
  registration_no text NOT NULL, fuel_type text,
  status text NOT NULL DEFAULT 'active'
       CHECK (status IN ('active','maintenance','retired','inactive')),
  last_known_odometer numeric(10,1),        -- denormalised from last closed trip
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (school_id, code)
);
CREATE TABLE bus_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, bus_id uuid NOT NULL REFERENCES buses(id),
  file_key text NOT NULL, sort_order int DEFAULT 0
);

CREATE TABLE bus_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, bus_id uuid NOT NULL REFERENCES buses(id),
  doc_type text NOT NULL CHECK (doc_type IN
     ('insurance','fitness','pollution','permit','rc','safety_inspection','other')),
  issuer text, doc_number text,
  start_date date, expiry_date date,
  file_key text, file_mime text,
  verification_status text DEFAULT 'pending'
     CHECK (verification_status IN ('pending','verified','rejected')),
  visible_to_parents_status boolean DEFAULT true,    -- show validity only
  visible_to_parents_file   boolean DEFAULT false,   -- show the file
  is_current boolean DEFAULT true,                   -- replaced docs kept as history
  created_at timestamptz DEFAULT now()
);

-- ───────────── STAFF ─────────────
CREATE TABLE staff_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, user_id uuid UNIQUE REFERENCES users(id),
  staff_type text NOT NULL CHECK (staff_type IN ('driver','conductor')),
  full_name text NOT NULL, photo_key text,
  phone text, email citext, address text,           -- address: internal only
  joining_date date, experience_summary text,
  id_proof_type text, id_proof_last4 text,          -- never store full Aadhaar/PAN
  id_verification_status text DEFAULT 'pending',
  licence_no text, licence_rto text, licence_issue_date date, licence_expiry_date date,
  licence_verification_status text DEFAULT 'pending',   -- drivers only
  is_active boolean DEFAULT true, deleted_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE staff_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, staff_id uuid NOT NULL REFERENCES staff_profiles(id),
  doc_type text NOT NULL CHECK (doc_type IN
    ('identity','licence_front','licence_back','character_certificate',
     'police_verification','training','first_aid','child_safety','other')),
  title text, issue_date date, expiry_date date,
  file_key text, verification_status text DEFAULT 'pending',
  visible_to_parents_status boolean DEFAULT true,
  visible_to_parents_file boolean DEFAULT false,
  is_current boolean DEFAULT true, created_at timestamptz DEFAULT now()
);

-- Historic assignments: past trips must show who/what was valid at that time
CREATE TABLE bus_staff_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, bus_id uuid NOT NULL REFERENCES buses(id),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id),
  assignment_role text NOT NULL CHECK (assignment_role IN
     ('primary_driver','backup_driver','conductor','backup_conductor')),
  valid_from timestamptz NOT NULL DEFAULT now(), valid_to timestamptz
);
-- At most one open primary driver per bus
CREATE UNIQUE INDEX one_primary_driver ON bus_staff_assignments(bus_id)
  WHERE assignment_role='primary_driver' AND valid_to IS NULL;

-- ───────────── ROUTES, STOPS, SCHEDULES ─────────────
CREATE TABLE routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, code text NOT NULL, name text,
  direction text NOT NULL CHECK (direction IN ('morning','afternoon')),
  is_active boolean DEFAULT true, deleted_at timestamptz,
  polyline_encoded text,                -- planned path (from routing API) for display
  distance_m int, UNIQUE (school_id, code, direction)
);
CREATE TABLE stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, route_id uuid NOT NULL REFERENCES routes(id),
  code text, name text NOT NULL, sequence int NOT NULL,
  latitude numeric(9,6) NOT NULL, longitude numeric(9,6) NOT NULL,
  geom geography(Point,4326) GENERATED ALWAYS AS
      (ST_SetSRID(ST_MakePoint(longitude::float8, latitude::float8),4326)::geography) STORED,
  expected_time time, arrival_radius_m int NOT NULL DEFAULT 100,
  UNIQUE (route_id, sequence)
);
CREATE TABLE bus_route_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, bus_id uuid NOT NULL, route_id uuid NOT NULL,
  valid_from timestamptz DEFAULT now(), valid_to timestamptz
);
CREATE TABLE trip_schedules (          -- recurring plan, generates daily trips
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, bus_id uuid NOT NULL, route_id uuid NOT NULL,
  direction text NOT NULL, planned_start_time time NOT NULL,
  days_of_week int[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  valid_from date, valid_to date, is_active boolean DEFAULT true
);

-- Student ↔ bus/route/stop (history kept)
CREATE TABLE student_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, student_id uuid NOT NULL REFERENCES students(id),
  trip_direction text NOT NULL CHECK (trip_direction IN ('morning','afternoon')),
  bus_id uuid NOT NULL, route_id uuid NOT NULL, stop_id uuid NOT NULL,
  valid_from date DEFAULT current_date, valid_to date
);
CREATE UNIQUE INDEX one_open_assignment ON student_assignments(student_id, trip_direction)
  WHERE valid_to IS NULL;

-- ───────────── TRIPS ─────────────
CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  schedule_id uuid REFERENCES trip_schedules(id),
  trip_type text NOT NULL CHECK (trip_type IN ('school','non_school')),
  direction text CHECK (direction IN ('morning','afternoon')),
  trip_date date NOT NULL,
  bus_id uuid NOT NULL, route_id uuid,
  driver_staff_id uuid, conductor_staff_id uuid,   -- snapshot at trip creation
  bus_code_snapshot text, route_code_snapshot text, -- survive later renames
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN
     ('scheduled','in_progress','completed','missed','cancelled','auto_closed')),
  planned_start_at timestamptz,
  started_at timestamptz, ended_at timestamptz,
  start_lat numeric(9,6), start_lng numeric(9,6),
  end_lat numeric(9,6),   end_lng numeric(9,6),
  start_odometer numeric(10,1), end_odometer numeric(10,1),
  distance_odometer_km numeric(8,1), distance_gps_km numeric(8,1),
  purpose text,                              -- required for non_school
  device_id uuid, started_by uuid, ended_by uuid,
  client_start_id uuid UNIQUE,               -- idempotency key from the app
  summary jsonb                              -- computed analytics
);
CREATE INDEX trips_school_date ON trips(school_id, trip_date);
CREATE INDEX trips_active ON trips(school_id) WHERE status='in_progress';
CREATE UNIQUE INDEX one_active_trip_per_bus ON trips(bus_id) WHERE status='in_progress';

CREATE TABLE trip_odometer_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, trip_id uuid NOT NULL REFERENCES trips(id),
  kind text NOT NULL CHECK (kind IN ('start','end','place')),
  reading numeric(10,1), file_key text NOT NULL,
  captured_at timestamptz NOT NULL,         -- device time
  latitude numeric(9,6), longitude numeric(9,6),
  sha256 text, source text DEFAULT 'camera' -- 'camera' | 'gallery'
);

-- Partitioned, high-volume
CREATE TABLE location_points (
  school_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL,         -- device timestamp (original)
  received_at timestamptz NOT NULL DEFAULT now(),
  latitude double precision NOT NULL, longitude double precision NOT NULL,
  speed_kmh real, heading real, accuracy_m real,
  battery_pct smallint, network_type text,
  is_moving boolean, is_backfilled boolean DEFAULT false,
  PRIMARY KEY (trip_id, recorded_at)
) PARTITION BY RANGE (recorded_at);
-- Monthly partitions created by a scheduled job (pg_partman or custom)

CREATE TABLE trip_stop_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, trip_id uuid NOT NULL, stop_id uuid NOT NULL,
  arrived_at timestamptz, departed_at timestamptz, dwell_s int
);

-- ───────────── ALERTS, LOGS, NOTIFICATIONS ─────────────
CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  alert_type text NOT NULL,   -- see §11
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  entity_type text, entity_id uuid,         -- bus / trip / staff / document
  trip_id uuid, bus_id uuid,
  title text, details jsonb,
  dedupe_key text,                          -- prevents duplicates
  status text NOT NULL DEFAULT 'open'
      CHECK (status IN ('open','reviewed','escalated','closed')),
  reviewed_by uuid, reviewed_at timestamptz, review_note text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX alerts_dedupe ON alerts(school_id, dedupe_key) WHERE status IN ('open','escalated');

CREATE TABLE fuel_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, bus_id uuid NOT NULL,
  fuel_date date NOT NULL, odometer numeric(10,1),
  litres numeric(8,2) NOT NULL, cost numeric(10,2) NOT NULL,
  station text, bill_key text, created_by uuid
);
CREATE TABLE maintenance_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, bus_id uuid NOT NULL,
  service_type text NOT NULL, service_date date NOT NULL,
  cost numeric(10,2), odometer numeric(10,1), vendor text, notes text,
  invoice_key text, next_due_date date, next_due_km numeric(10,1)
);

CREATE TABLE notification_preferences (
  school_id uuid NOT NULL, parent_account_id uuid NOT NULL, student_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('morning','afternoon')),
  trip_started boolean DEFAULT true, bus_left_school boolean DEFAULT true,
  approaching_stop boolean DEFAULT true, arrived_at_stop boolean DEFAULT true,
  trip_delayed boolean DEFAULT true, trip_not_started boolean DEFAULT true,
  PRIMARY KEY (student_id, parent_account_id, direction)
);
CREATE TABLE notification_events (    -- dedupe + audit of what was sent
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL, trip_id uuid NOT NULL, student_id uuid,
  event_type text NOT NULL, channel text DEFAULT 'push',
  sent_at timestamptz DEFAULT now(), status text,
  UNIQUE (trip_id, student_id, event_type)   -- one per event per trip
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid, owner_type text, owner_id uuid,    -- user or parent_account
  platform text, device_model text, app_version text,
  fcm_token text, is_trusted boolean DEFAULT true, last_seen_at timestamptz
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL, owner_id uuid NOT NULL, school_id uuid,
  device_id uuid, refresh_hash text NOT NULL, family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  school_id uuid,                       -- NULL for platform-level actions
  actor_type text, actor_id uuid, actor_name text, ip inet, user_agent text,
  action text NOT NULL,                 -- 'bus.create','document.replace',...
  entity_type text, entity_id uuid,
  old_values jsonb, new_values jsonb,   -- redact secrets
  created_at timestamptz DEFAULT now()
);
-- audit_logs: INSERT-only for app_user (REVOKE UPDATE, DELETE)
```

### 6.3 Indexing and performance notes

- `location_points`: monthly partitions, PK `(trip_id, recorded_at)`. Batch insert (multi-row `INSERT ... ON CONFLICT DO NOTHING`) to make offline-sync retries idempotent.
- Retention: keep raw points for N months (suggest 6–12, a school-configurable policy). Afterwards downsample to a simplified polyline stored in `trips.summary` and drop old partitions.
- Add composite indexes starting with `school_id` where listing screens filter by it (`(school_id, status)`, `(school_id, bus_id, trip_date)`).
- Never trust `deleted_at IS NULL` filters alone. Put them in views (`v_buses`) or repository defaults.

---

## 7. Backend (Node/Express) Design

### 7.1 Module structure

```
apps/api/src/
├── app.ts  server.ts  socket.ts
├── config/             # env (zod-validated), constants
├── db/                 # pool manager (getPool(tenant)), withTenant, migrations runner
├── middleware/         # authenticate, resolveTenant, authorize, rateLimit,
│                       # validate(zod), errorHandler, requestId, auditContext
├── modules/
│   ├── auth/           # login, otp, refresh, logout, change/reset password
│   ├── platform/       # schools, platform-settings, platform-health
│   ├── school/         # profile, settings, visibility
│   ├── users/          # school admins, staff logins, reset access
│   ├── staff/          # drivers & conductors, documents
│   ├── buses/          # buses, images, documents
│   ├── routes/         # routes, stops, schedules, route polyline
│   ├── students/       # students, parents, CSV import, assignments
│   ├── trips/          # driver trip lifecycle, history, evidence
│   ├── tracking/       # ingest, live state, socket rooms, analytics
│   ├── alerts/
│   ├── fuel/  maintenance/
│   ├── reports/        # CSV/PDF exports
│   ├── parent/         # parent-facing read APIs (sanitised DTOs)
│   ├── files/          # upload URLs, signed download, access control
│   ├── notifications/  # FCM, templates, SMS/WhatsApp adapters
│   └── audit/
└── shared/             # errors, pagination, dto mappers, crypto
```

Each module follows: `routes.ts → controller.ts → service.ts → repository.ts` (+ `schema.ts` for Zod).
**Rule:** repositories only receive a `tx` from `withTenant`, never the global pool.

### 7.2 Cross-cutting rules

- **Validation:** every request body/query/param validated with Zod. Unknown keys stripped (prevents mass assignment of `school_id`).
- **Response DTOs for parents:** build parent responses through mapper functions that apply `school_settings.parent_visibility`. Never return raw entities to the parent API.
- **Pagination:** cursor or `page/limit` with max limits, plus server-side filters and sorting on all list endpoints.
- **Idempotency:** `client_start_id` for starting trips, `ON CONFLICT DO NOTHING` for location batches, `Idempotency-Key` header for uploads.
- **Errors:** consistent `{ code, message, details, requestId }`. Return `404` (not `403`) for cross-tenant IDs to avoid information leaks.
- **Audit:** a service-level helper `audit.log({action, entity, old, new})` called inside the same transaction as the change.
- **Rate limiting:** Redis-based, per IP + per identity. Stricter on login/OTP.
- **Soft delete:** "delete" in the admin panel means set `deleted_at`. Block deleting buses/routes with active trips; keep history.

### 7.3 Background jobs (BullMQ + cron)

| Job | Schedule | Purpose |
|---|---|---|
| `generate-daily-trips` | Daily per school timezone (e.g., 00:05 local) | Create `scheduled` trips from `trip_schedules` |
| `trip-not-started-check` | Every minute | Scheduled trips past `planned_start + grace` and not started → alert + optional parent notification |
| `document-expiry-scan` | Daily | Bus docs, staff licences/certificates vs thresholds → alerts; flags missing required docs |
| `stale-trip-closer` | Every 5 min | `in_progress` trips with no points for X hours → mark `auto_closed`, raise alert |
| `location-gap-detector` | Every minute | Trip active but no points beyond expected interval → "Location Unavailable" and GPS/network alert |
| `trip-finalizer` | On trip end | Compute distance, path simplification, stop dwell, deviation, summary |
| `partition-maintenance` | Monthly | Create next partitions and drop expired ones |
| `maintenance-due-scan` | Daily | Service due by date or km → alert |
| `session-cleanup` | Daily | Remove expired sessions and OTPs |

---

## 8. API Catalogue

Base: `/api/v1`. All JSON. All write endpoints are audited. `school_id` always derives from the token (or `X-School-Id` for parents), never from the body.

### 8.1 Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/platform/login` | Super admin (email, password, TOTP) |
| POST | `/auth/school/login` | School admin (email, password) |
| POST | `/auth/staff/login` | `school_code`, `phone/username`, `password`, `device` info |
| POST | `/auth/parent/otp/request` · `/auth/parent/otp/verify` | Mobile + OTP |
| POST | `/auth/refresh` · `/auth/logout` | Rotating refresh |
| POST | `/auth/change-password` | Required on first login |

### 8.2 Platform (Super Admin) · `/platform/*`

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/platform/schools` | List (search/filter by status), create school **with** initial admin (single transaction) |
| GET/PATCH | `/platform/schools/:id` | View/edit school details |
| POST | `/platform/schools/:id/activate` · `/deactivate` | Status change (deactivation revokes sessions and blocks logins and location ingestion) |
| DELETE | `/platform/schools/:id` | Soft delete |
| POST | `/platform/schools/:id/admin/reset-password` | Reset the school admin's access only |
| GET/PUT | `/platform/settings` | Global defaults |
| GET | `/platform/health` | Counts only: active schools, active trips now, API/queue health |
| GET | `/platform/audit-logs` | Platform-level actions only |

### 8.3 School Admin · `/school/*`

| Area | Endpoints (summary) |
|---|---|
| Profile/Settings | `GET/PATCH /school/profile`, `GET/PUT /school/settings` (thresholds, features), `GET/PUT /school/settings/parent-visibility` |
| Admin users | CRUD `/school/admins` (+ `/:id/reset-access`, `/activate`, `/deactivate`) |
| Buses | CRUD `/school/buses`, `PATCH /:id/status`, `POST /:id/images`, `POST /:id/assign-staff`, `GET /:id/assignment-history` |
| Bus documents | `GET/POST /school/buses/:id/documents`, `PUT /school/bus-documents/:docId` (replace keeps history), `PATCH .../visibility`, `DELETE` |
| Routes/Stops | CRUD `/school/routes`, CRUD `/school/routes/:id/stops`, `PUT /routes/:id/stops/reorder`, `POST /routes/:id/recompute-polyline` |
| Schedules | CRUD `/school/trip-schedules` |
| Staff | CRUD `/school/staff?type=driver|conductor`, `POST /:id/credentials` (create/reset login), `/activate`, `/deactivate`; documents CRUD + verify (`PATCH /staff-documents/:id/verify`) |
| Students | CRUD `/school/students`, `POST /school/students/import` (CSV, with dry-run preview and error report), `GET /school/students/import/template` |
| Parents | CRUD `/school/parents`, link/unlink `POST /school/students/:id/parents`, reset access |
| Assignments | `PUT /school/students/:id/assignment` (bus/route/stop per direction), bulk `POST /school/assignments/bulk` |
| Live fleet | `GET /school/fleet/live` (all buses and their last position and status) plus Socket.IO `school:{id}:fleet` |
| Trips | `GET /school/trips` (filters: date range, bus, route, driver, conductor, type, status), `GET /school/trips/:id` (detail with path, stops, evidence URLs, flags), `GET /school/trips/:id/path` |
| Alerts | `GET /school/alerts`, `PATCH /school/alerts/:id` (review, note, escalate, close) |
| Fuel/Maintenance | CRUD `/school/fuel-logs`, `/school/maintenance-logs` |
| Reports | `GET /school/reports/{bus-distance|fuel|maintenance|cost-per-km|service-due|non-school-usage|trip-summary}?format=json|csv|pdf` |
| Dashboard | `GET /school/dashboard` |
| Audit | `GET /school/audit-logs` |
| Files | `POST /files/upload-url`, `GET /files/:id/url` (see §12) |

### 8.4 Driver/Conductor · `/driver/*`

| Method | Path | Purpose |
|---|---|---|
| GET | `/driver/me` | Profile, assigned buses/routes |
| GET | `/driver/home` | Today's trips (morning/afternoon), statuses, notices, school config (intervals, thresholds, non-school allowed?) |
| POST | `/driver/trips/start` | `client_start_id`, trip id or non-school type, bus, odometer reading, **odometer photo**, coordinates, device time, purpose (non-school) |
| POST | `/driver/trips/:id/locations` | **Batch** of points (also used for offline backfill). Server enforces limits (see §9) |
| POST | `/driver/trips/:id/end` | End odometer, photo, end coordinates |
| GET | `/driver/trips/active` | Resume after app restart or crash |
| GET | `/driver/trips/history` | Own trips only |
| POST | `/driver/trips/:id/events` | Optional: device warnings (GPS off, low battery) |
| POST | `/driver/devices` | Register FCM token, device info |

### 8.5 Parent · `/parent/*` (with `X-School-Id` after selecting a child)

| Method | Path | Purpose |
|---|---|---|
| GET | `/parent/children` | All children grouped by school, with bus code, route, stop, next pickup/drop, trip status |
| GET | `/parent/children/:studentId/tracking` | Snapshot: status, last position, last update time, ETA, planned polyline, stop and school coordinates |
| GET | `/parent/children/:studentId/bus` | Bus details **filtered by visibility** |
| GET | `/parent/children/:studentId/staff` | Driver and conductor cards (filtered) |
| GET | `/parent/files/:fileId/url` | Only if visibility allows the file |
| GET/PUT | `/parent/children/:studentId/notification-preferences` | Per direction toggles |
| POST | `/parent/devices` | FCM token |
| Socket | `child:{studentId}:live` | Server verifies the link before joining |

### 8.6 Socket.IO rooms and auth

- Handshake authenticates JWT. Join rules are re-checked server-side on every `join`.
- `school:{schoolId}:fleet` → school admins of that school only.
- `trip:{tripId}` → school admins of the trip's school; parents with an active assignment to this bus **and** trip direction.
- Server emits to parent rooms **at most once per 10 s per trip** (coalesced), and at the reduced rate while stopped.

---

## 9. Live Tracking Engine

### 9.1 Driver app → server (ingestion)

Rules from the FRD, with the engineering detail:

| Rule | Implementation |
|---|---|
| Track only during an active trip | Foreground service/background location starts after `trips/start` succeeds and stops immediately after `trips/end` success **or** the user confirms ending |
| Moving: 1 update / **10 s**, never faster | App-side timer with a hard floor of 10 s. Server also drops live points that arrive closer than ~9 s after the previous accepted point from the same trip (tolerance for clock jitter). Backfilled points with older `recorded_at` are accepted (sorted, de-duplicated). |
| Moving threshold | `speed > moving_speed_kmh` (default 4; platform/school configurable). Use smoothed speed (median of last 3 samples) plus GPS accuracy filter (ignore points with accuracy > ~50 m for state changes). |
| Stopped after 60 s at ≤ threshold | App state machine: `MOVING → (speed ≤ thr for ≥ 60 s) → STOPPED`. |
| Stopped interval 60–120 s | Value from config (default 90 s). |
| Resume | First sample with speed > thr switches back to 10 s immediately. |
| HTTPS + retries + unauthorized rejection | TLS only. Each request carries JWT and device id. Server checks: user active, school active, trip belongs to this driver/conductor, trip `in_progress`, device matches `trips.device_id`. Otherwise `401/403`. |

**Client state machine**

```
IDLE ─start trip OK→ TRACKING_MOVING ◄──── speed>thr ────┐
                          │ speed≤thr for 60s            │
                          ▼                              │
                    TRACKING_STOPPED ────────────────────┘
                          │ end trip OK
                          ▼
                        IDLE (location services stopped)
```

**Batch payload**

```json
POST /driver/trips/{tripId}/locations
{
  "device_id": "…",
  "points": [
    { "t": "2026-10-19T07:31:10.000Z", "lat": 28.6692, "lng": 77.4538,
      "spd": 31.2, "hdg": 270, "acc": 8, "bat": 74, "net": "4g", "mv": true }
  ]
}
```

Response includes `server_time`, `next_interval_s` (so the server can retune intervals remotely), and `trip_status` (so the app can detect an admin cancellation or auto-close).

### 9.2 Server processing pipeline

```
HTTP ingest ─► validate + authorize ─► rate/interval check ─► sort+dedupe
   ├─► Redis: SET live:{school}:{trip} (latest point, status, ts)   ← source of truth for live maps
   ├─► Redis Stream/BullMQ: enqueue "points.persist" (batched DB insert)
   └─► Redis pub/sub: publish trip:{id}  → Socket.IO gateway
                                    │
                                    ▼  (worker: per accepted live point)
                       stop-arrival detection (geofence via PostGIS or in-memory haversine)
                       deviation / speeding / long-stop checks (if enabled)
                       ETA recompute · notification triggers
```

- The **ingest endpoint must stay fast**. Do persistence and analytics asynchronously.
- Keep the latest position and ETA per trip in Redis with a TTL. A parent opening the app reads from Redis (cheap) and then subscribes to the socket.

### 9.3 Parent app live data

- Subscribe via Socket.IO (`child:{studentId}:live`). Server coalesces to ≥ 10 s.
- Fallback: poll `/tracking` no more often than every 10 s (when moving) and 60 s (when stopped).
- UI always shows **"Last updated hh:mm:ss"** and flips to **"Location unavailable"** when the last point is older than a threshold (e.g., 3× the expected interval).
- Smooth the marker with interpolation/animation between points (Ola/Uber feel) without faking data. Animate over the 10 s interval, never display positions that were not received.

### 9.4 Parent-facing status derivation

| Status | Rule |
|---|---|
| Not Started | Trip scheduled, not `in_progress`, planned time not exceeded by grace |
| On Route | `in_progress`, last point fresh, `is_moving` |
| Bus Stopped | `in_progress`, state STOPPED, point fresh |
| Delayed | ETA to child's stop later than expected time + delay threshold, or trip not started past grace |
| Arrived at Stop | Bus entered the child's stop geofence (`arrival_radius_m`) |
| Completed | Trip `completed` |
| Location Unavailable | `in_progress` but last point older than the staleness threshold |

### 9.5 ETA calculation

- **v1 (no paid API per update):** project the bus position onto the route polyline (PostGIS `ST_LineLocatePoint`), compute remaining distance to each upcoming stop along the polyline, divide by a **smoothed recent speed** (e.g., exponentially weighted over the last 3–5 minutes with a floor so a red light doesn't give infinite ETA) and add typical dwell per stop. Blend with the planned timetable for stability.
- **v2 (optional):** call a routing API (Google Directions, Mapbox, OSRM) for remaining stops every N minutes rather than per point. Cache the result in Redis.
- Only show ETA when data quality is adequate (recent, accurate points). Otherwise show the status without an ETA.

### 9.6 Analytics (post-trip, `trip-finalizer`)

- Actual path (simplified with `ST_SimplifyPreserveTopology`), duration, GPS distance (sum of segment distances after outlier filtering), stop dwell per stop, planned-vs-actual deviation (max and average distance from the planned polyline), over-speed events, harsh events (when sensor data is sent).
- Flags generated only when the school enabled the feature and data quality is sufficient.

---

## 10. Trip Lifecycle and Odometer Validation

### 10.1 State machine

```
(cron) scheduled ──start──► in_progress ──end──► completed
    │                           │  ▲                  
    │ grace passed, never       │  └ resume (app reopened; GET /trips/active)
    ▼ started                   ├──► auto_closed (no data for X hours)
  missed                        └──► cancelled (admin)
```

Non-school trips are created on start (no schedule), `trip_type='non_school'`, allowed only if `allow_non_school_trips` is true, and `purpose` is mandatory.

### 10.2 Start-trip validation (server-side, in one transaction)

1. User active, school active, user is assigned to the bus (primary/backup driver or conductor) in the current assignment window. A backup driver must be allowed to start (the school's assignment config decides).
2. No other `in_progress` trip for this bus (`one_active_trip_per_bus`) and none for this user.
3. Odometer reading present, numeric, and a photo uploaded with `source='camera'`. If `odometer_gallery_allowed=false`, reject any other source. Verify via the capture metadata sent by the app and the signed upload (see §12). Store the SHA-256 and device timestamp + GPS.
4. `start_odometer ≥ bus.last_known_odometer` (otherwise flag, see below).
5. Record start time (server), device time, user, bus, route, coordinates, device id.
6. Return trip config (intervals, thresholds). The app starts tracking.

### 10.3 End-trip validation

1. Ending reading ≥ start reading (hard reject if lower).
2. Live camera photo required.
3. Compute `distance_odometer = end − start`. Compute GPS distance. Flag if `|odo − gps| / max(odo, gps) > odometer_gps_variance_pct` **and** the absolute difference is above a minimum km (avoid noise on short trips).
4. Compare with previous closed trip of the same bus: `gap = this.start_odometer − previous.end_odometer`. If `gap > odometer_mismatch_threshold_km` → alert **"Unexplained odometer gap (possible unrecorded use)"**. If `gap < 0` → alert **"Odometer decreased/tampering suspected"**.
5. Update `buses.last_known_odometer`. Mark `completed`. Stop tracking. Enqueue `trip-finalizer`.
6. Server stores the end point and location. Even if the final location batch fails, the end is accepted and pending points are backfilled later (the trip allows late points for a short window, e.g., 24 h).

### 10.4 Edge cases to design for (not in FRD)

| Case | Handling |
|---|---|
| Driver force-closes the app mid-trip | Foreground service keeps running on Android. On iOS use "always" location + significant-change fallback. On relaunch call `/trips/active` and resume. |
| Phone dies / no end | `stale-trip-closer` → `auto_closed` + alert. Admin can enter a corrected end reading (audited). |
| Wrong odometer entered | Admin "correct reading" action with reason, audited, original preserved. |
| Mid-trip change of driver | Admin "reassign trip" action (audited) or end and start a new trip. Trip snapshot keeps history. |
| Bus breakdown | Driver can mark "Trip interrupted" and the school can cancel. Parents are notified if enabled. |
| Backup driver uses a bus | Assignment-based authorization with backup roles. |
| Two devices for one driver | Trip is bound to the start device. Others get `409`. |

---

## 11. Alerts and Notifications Engine

### 11.1 Alert catalogue

| `alert_type` | Trigger | Severity | Source |
|---|---|---|---|
| `trip_not_started` | Scheduled trip not started by planned time + grace | warning | cron |
| `odometer_gap` | Prev end vs next start gap > threshold | warning/critical | trip start |
| `odometer_decrease` | New reading lower than last | critical | trip start/end |
| `odometer_gps_mismatch` | Odometer km differs from GPS km beyond variance | warning | trip end |
| `non_school_trip` | Non-school trip logged (info feed) | info | trip end |
| `doc_expiring` / `doc_expired` / `doc_missing` | Bus doc or staff licence/certificate vs reminder thresholds (configurable, e.g., 60/30/15/7/1 days) | warning/critical | daily cron |
| `service_due` | Maintenance due by date/km | warning | cron |
| `speeding` | Speed > limit (feature flag) | warning | ingest |
| `harsh_driving` | Sensor-based (flag) | warning | ingest |
| `route_deviation` | Distance from polyline > threshold for N points | warning | ingest |
| `long_stop` | Unscheduled stop (outside stop geofences) > threshold | warning | ingest |
| `gps_disabled` / `low_battery` / `no_network` | Reported by the app or detected by gap | warning | app/cron |
| `trip_auto_closed` | No data for X hours | warning | cron |

Alerts use `dedupe_key` (e.g., `doc_expiring:{doc_id}:{threshold}`) so repeated scans don't spam. Admin flow: **open → reviewed (note) → closed / escalated**. Escalation notifies the configured `alert_recipients`.

### 11.2 Notification catalogue

**Parents (push; SMS/WhatsApp optional module via adapter interface):**

| Event | Trigger |
|---|---|
| Trip started | Trip goes `in_progress` (students assigned to that bus and direction) |
| Bus left school | Morning: leaves school geofence. Afternoon: first departure from school. |
| Approaching stop | ETA to the child's stop ≤ `approaching_stop_minutes` (default 5). Fire once per trip per student. |
| Arrived at stop | Entered geofence of the child's stop |
| Trip delayed | Delay threshold crossed |
| Trip not started | Past grace, if the school enabled it |

Rules: respect each parent's per-child per-direction preference. Dedupe via `notification_events UNIQUE (trip_id, student_id, event_type)`. Notifications carry only a child's first name and the bus code (no sensitive data on the lock screen).

**Driver app:** GPS off, poor connectivity, battery low (local alerts), school announcements.

**Admin web:** in-app alert bell via Socket.IO + optional email digest.

**Channel adapters:** `NotificationChannel` interface (`push`, `sms`, `whatsapp`, `email`). Only `push` is enabled by default. Others are feature-flagged per school (the "optional paid module").

---

## 12. File and Document Storage

- **Private bucket only.** No public ACLs. Object key: `schools/{school_id}/{category}/{entity_id}/{uuid}.{ext}`.
- **Upload flow:** client calls `POST /files/upload-url` with `{category, entity_id, mime, size}` → server authorizes (role + tenant + entity ownership), creates a `files` record (optional table with id, school_id, key, mime, size, sha256, uploader, status) and returns a **presigned PUT URL** (short TTL, size/mime limits) → client uploads → client calls the business endpoint with the `file_id`. A scan/validation job checks mime/magic bytes and size.
- **Download flow:** `GET /files/:id/url` → server checks `file.school_id == ctx.school_id` and role rules (parents: only if the visibility flag permits and the file belongs to their child's bus/staff) → returns a **presigned GET URL (60–300 s)**. Never expose bucket keys directly.
- **Images:** generate thumbnails (sharp) for bus/staff/odometer photos. Strip EXIF GPS from parent-visible images.
- **Odometer photos:** keep original; store the capture time, GPS and SHA-256 for evidence.
- **Retention:** configurable per school. Replacing a document sets old `is_current=false` and keeps the file for audit.
- **Sensitive IDs:** store only masked identifiers (last 4). The ID document image, if uploaded, is admin-only and never parent-visible by default.

---

## 13. Web Admin Panel (React + Vite)

One codebase, two layouts, role-guarded routes. Optionally serve the Super Admin on a separate subdomain (`platform.yourdomain.com`) and the schools on `app.yourdomain.com` or `{schoolcode}.yourdomain.com` for cleaner separation. The same build can be used.

### 13.1 Frontend architecture

```
apps/web/src/
├── app/              # router, providers, guards (RequireRole), layouts
├── features/
│   ├── platform/     # schools, settings, health
│   └── school/       # dashboard, fleet-live, buses, routes, staff, students,
│                     # parents, trips, alerts, fuel, maintenance, reports, settings
├── components/       # DataTable, FormFields, FileUploader, MapView, StatusChip, ConfirmDialog
├── lib/              # apiClient (axios + refresh interceptor), socket, queryClient
└── theme/
```

- TanStack Query for server state. Socket events update the query cache for live fleet.
- Never rely on hiding UI for security. The server enforces everything.
- School branding: show the school's name/logo in the header and login.
- CSV import UI: upload → dry-run validation preview (row errors) → confirm.

### 13.2 Super Admin screens

| Screen | Contents |
|---|---|
| Login | Email + password + TOTP |
| Dashboard | Counts: schools (active/suspended), active trips now, API/queue status. **No school rows.** |
| Schools list | Search, filter by status, create |
| Create/Edit school | Name, code, address, logo, contacts, timezone, location, **initial School Admin** (name, email, temp password or invite link) |
| School detail | Status toggle (activate/deactivate), reset admin password, soft delete, tenant mode (shared/dedicated), usage summary (counts only) |
| Global settings | Default location intervals, moving threshold, stopped-after seconds, document-expiry reminder days, feature flags and modules (SMS/WhatsApp) |
| Platform audit | Who created/edited/deactivated which school |

### 13.3 School Admin screens

| Screen | Contents |
|---|---|
| Dashboard | Total buses, active trips, completed, not started, expiry alerts, odometer discrepancies, safety/route alerts, quick links |
| **Live Fleet** | Bus list (code, status, driver/conductor, last update, trip info) + map of all buses. Click a bus for a side panel: live map, trip data, route, staff, last location, start odometer, current alerts. |
| Buses | Table, create/edit (code, name, type, capacity, plate, fuel, images, status), assign driver/conductor, documents tab (insurance, fitness, optional ones, expiry badges, replace, visibility toggles), assignment history |
| Routes & Stops | Route list; route editor with a **map-based stop editor** (click to place, drag, reorder, radius slider), expected times, morning/afternoon, planned polyline preview |
| Schedules | Bus ↔ route ↔ direction ↔ time ↔ days |
| Staff | Drivers/Conductors tables; profile form; identity, licence, documents with verification status; credential create/reset; assignment history; parent-visibility preview |
| Students | Table with filters (class, bus, route, unassigned), create/edit, CSV import, assignment (bus → route → stop per direction), bulk assign |
| Parents | Table, link to children, reset access, import |
| Trips & Audit | Filters (date, bus, route, driver, conductor, type, status). Trip detail: planned vs actual path on the map, timeline of stop events, odometer start/end values and photos side by side, distance (odometer vs GPS), flags. Export CSV/PDF. |
| Alerts | Inbox with severity filters. Review note, escalate, close. |
| Fuel | Log, bill image, per-bus mileage trends |
| Maintenance | Log, invoice, next due, due list |
| Reports | Bus-level distance, fuel, maintenance, cost per km, service due, non-school usage, trip summaries. Date range and export. |
| Settings | School profile, thresholds (mismatch km, grace, stop duration, speed limit, deviation), non-school trips toggle, gallery-upload toggle, alert recipients, **parent visibility matrix** (with a live preview of what a parent sees) |
| Users & Roles | Additional school admins |
| Audit logs | Filter by actor/action/entity/date, with a before/after diff |

---

## 14. Driver/Conductor App (Flutter)

### 14.1 Architecture

- **Clean architecture + Riverpod**: `presentation → application (controllers) → domain → data (api, local db)`.
- Packages: `dio`, `riverpod`, `go_router`, `freezed`, `geolocator`, `flutter_foreground_task` (or `flutter_background_service`) for background tracking, `camera` (live capture; **not** `image_picker` gallery for odometer), `drift` + **SQLCipher** (encrypted offline queue), `flutter_secure_storage`, `connectivity_plus`, `battery_plus`, `firebase_messaging`, `permission_handler`, `workmanager` (retry uploads).
- Shared `core` package with the API client, auth and models.

### 14.2 Screens and flows

```
Splash → Login (school code, mobile/username, password)
       → (first login) Change password
       → Home (today's trips: morning/afternoon, status chips, announcements)
              ├ Start Trip
              │    1. choose bus + scheduled trip   (or "Non-school trip" if allowed → purpose)
              │    2. pre-trip checks: GPS on, location permission, battery, network
              │    3. enter odometer + take LIVE photo (preview/retake, auto timestamp+GPS)
              │    4. Start → server confirms → tracking starts
              ├ Active Trip
              │    route + next stop, trip timer, GPS/network/battery indicators,
              │    offline queue counter, banner alerts, [End Trip]
              ├ End Trip
              │    end odometer + LIVE photo → confirm → upload pending points → finish
              ├ Trip History (own trips)
              └ Profile / Assigned bus & route / Logout
```

### 14.3 Background tracking details

- **Android:** foreground service with a persistent notification ("Trip in progress – location is being shared"), `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION`. Handle battery-optimization exemption guidance (OEM-specific: Xiaomi, Oppo, Vivo, Samsung kill background apps. Include an in-app guide).
- **iOS:** Background Modes → Location updates, "Always and When In Use", `showsBackgroundLocationIndicator`, clear usage descriptions. Tracking only during trips, as the FRD requires, and say so in the permission rationale (needed for App Store review).
- Location service stops when the trip ends. Nothing runs outside a trip.
- **Interval governor** implements the §9.1 state machine with a hard 10 s floor.
- **Offline queue:** points written to the encrypted local DB first, then flushed in batches. Upload on success, retry with exponential backoff, resume on connectivity. Original `recorded_at` preserved. Flush the queue before final `end` confirmation where possible, else after.
- **Driver alerts (local):** GPS turned off, no data connection, battery < 15–20 %, mock-location detected (Android `isMock`), prompts "Please charge phone / enable GPS".
- **Anti-tamper:** reject mock locations (flag to server), device-time vs server-time drift check, root/jailbreak signal (optional), camera-only odometer capture with an in-image timestamp/GPS overlay.
- **Resilience:** on app restart call `/driver/trips/active` and restore the Active Trip screen.
- **Localization:** i18n ready from day one (Hindi + English likely required).

---

## 15. Parent App (Flutter)

### 15.1 Architecture

Same stack as the driver app. Additional: `google_maps_flutter` (or `flutter_map` + OSM), `socket_io_client`, `firebase_messaging`, `flutter_local_notifications`, polyline utilities, marker animation helper.

### 15.2 Screens and flows

```
Splash → Mobile number → OTP → Home
Home: one card per child, grouped under school headers
      [School logo/name]
        └ Child card: name · bus code (e.g. R1) · route · stop · next pickup/drop time · status chip
             actions: [Track Bus] [Bus Details] [Driver/Conductor] [Notifications]
Track Bus: full-screen map
      • moving bus marker (animated), planned route polyline, child's stop, school marker
      • status chip, ETA to my stop + next stop, "Last updated 07:31:10"
      • bottom sheet: bus code, driver name, call button (only if visible)
Bus Details: code/name, type, route, plate, capacity (if allowed), photos,
      insurance & fitness validity (+ files if enabled)
Driver / Conductor: photo, name, phone/email (if enabled), experience,
      licence validity, training, verification, character certificate status
Notification Settings: per child → morning / afternoon → toggles per event
Settings: language, logout
```

### 15.3 Notes

- Strictly read-only. No edit endpoints are used.
- Multi-school: the school switcher is implicit (the home list is grouped). Each child card sets `X-School-Id` for its requests, and the UI shows the school name/logo in every child screen so data is visibly separated.
- Handle empty states: no bus assigned, trip not started, location unavailable, stale data.
- Only parents with a live assignment to this bus/trip direction can open tracking. If the child is reassigned, access moves immediately with the assignment.
- **Per-school branding** (logo and colors from the school record) is cheap to add and is a strong selling point.
- Deep link from push notifications to the Track screen.

---

## 16. Security, Privacy and Compliance

| Area | Measure |
|---|---|
| Transport | TLS 1.2+ everywhere, HSTS, certificate pinning in apps (optional), WSS only |
| AuthN | argon2id, rotating refresh tokens, OTP rate limits, device binding, 2FA for Super Admin |
| AuthZ | Role guards + ownership checks + Postgres RLS (FORCE). DB user is not the owner and has no `BYPASSRLS`. |
| Tenant leakage | Test suite in §4.9, 404 on foreign IDs, no `school_id` from clients, tenant-prefixed cache keys (`live:{school}:…`), tenant-checked socket rooms, tenant-aware search and reports |
| Input | Zod validation, parameterized queries only, upload mime/size/magic-byte checks, CSV formula-injection escaping on exports |
| Web | Helmet, strict CORS allow-list, CSRF-safe token storage (access token in memory; refresh via httpOnly secure cookie on web), CSP |
| Secrets | Env/secrets manager, no secrets in the repo, rotate JWT keys (support `kid`) |
| Files | Private bucket, short signed URLs, EXIF stripped for parent-visible images |
| Data minimization | Mask Aadhaar/PAN (store last 4), staff address internal only, parents see only enabled fields |
| Audit | All critical actions logged, insert-only table, include actor/IP/old/new |
| Backups | Automated daily PG backups + WAL/PITR, tested restore, object-storage versioning |
| Monitoring | Sentry (API, web, Flutter), Prometheus/Grafana or a hosted APM, uptime checks, health endpoints (`/healthz`, `/readyz`) |
| Privacy law | Children's location and data are sensitive. Under India's **DPDP Act 2023** schools are data fiduciaries and we are the processor. Provide a DPA/terms, parental consent flow, retention policy, and deletion/export on request. Confirm with legal counsel. |
| Store policies | Prominent background-location disclosure for Play Store and App Store review. Privacy policy URL per app. |

---

## 17. DevOps, Deployment and Observability

- **Environments:** `local` (docker-compose: Postgres+PostGIS, Redis, MinIO), `staging`, `production`.
- **Containers:** `api`, `worker`, `web` (static via Nginx/CDN). Socket.IO behind sticky sessions or the Redis adapter with WebSocket-only transport.
- **Start small:** one VM or small Kubernetes/ECS cluster with managed PostgreSQL (backups/PITR) and managed Redis. Scale `api` horizontally. Scale `worker` by queue.
- **CI/CD (GitHub Actions):** lint → typecheck → unit tests → **tenant isolation tests** → migration dry-run → build → deploy. Flutter: build and distribute via Firebase App Distribution / TestFlight and Play Internal testing.
- **Migrations:** SQL migrations (node-pg-migrate/Drizzle Kit), forward-only, reviewed. Migration helper that auto-adds RLS to tables with `school_id`.
- **Observability:** structured logs (pino) with `requestId`, `schoolId`, `userId`. Metrics: ingest rate, ingest p95 latency, queue lag, socket connections, active trips, push success rate, DB connections.
- **Capacity sketch:** 50 schools × 40 buses × 2 trips/day × ~1 h × 6 points/min ≈ 50×40×2×360 = **~1.4 M points/day** at full activity. Comfortable for partitioned Postgres with batched inserts. Redis keeps live state.
- **Load tests:** k6 scripts for ingest and socket fan-out before onboarding the first large school.

---

## 18. Delivery Plan (Phases)

| Phase | Scope | Outcome |
|---|---|---|
| **0 – Foundations** | Monorepo, CI, DB migrations, RLS helper + isolation tests, auth (all 4 login types), tenant context, file service, audit helper, design system | Secure skeleton that every module reuses |
| **1 – Platform + School setup** | Super Admin: schools CRUD, initial admin, global settings. School Admin: profile/settings, admins, buses, bus documents, routes/stops (map editor), staff + documents, students/parents + CSV import, assignments | A school can be fully configured |
| **2 – Trips and Tracking (core)** | Driver app (login, start/end trip, odometer capture, background tracking, offline queue), ingest pipeline, Redis live state, Socket.IO, admin live fleet and trip detail map | End-to-end live tracking |
| **3 – Parent app** | OTP login, multi-school dashboard, live map + ETA, bus/staff details with visibility rules, notification preferences, push (FCM) | Parent value delivered |
| **4 – Alerts, analytics, reports** | Alert engine and inbox, expiry scans, odometer rules, route deviation/speeding/long stop, fuel and maintenance logs, reports + CSV/PDF export, audit viewer | Operational control and compliance |
| **5 – Hardening and launch** | Security review, load testing, backups/DR drill, store submissions, pilot school onboarding, docs/training, monitoring dashboards | Production release |
| **Later** | SMS/WhatsApp module, subscription/billing, dedicated-tenant migration tooling, attendance (board/alight) | Growth |

Delivery order recommendation: **build Phase 2 as early as possible in a thin form** (a vertical slice) because background GPS on real Android/iOS devices is the largest technical risk.

---

## 19. Gaps in the FRD and Questions for the Client

The FRD is clear on behavior but silent or ambiguous on these points. Resolve early, because several affect cost or architecture.

| # | Topic | Why it matters / our default |
|---|---|---|
| 1 | **Maps and routing provider** (Google vs Mapbox vs OSM) | Google Maps can be costly at scale. Default: Google Maps SDK in apps, Leaflet/OSM acceptable for admin. Decide who pays. |
| 2 | **SMS/OTP provider and cost** | Parent OTP login needs an SMS gateway (MSG91, Twilio, etc., with DLT registration in India). Default: OTP login with a provider adapter. |
| 3 | **Who pays the "paid module"** (SMS/WhatsApp) | Needs a per-school feature flag and usage metering. |
| 4 | **Billing/subscriptions** | Not in the FRD. See §20. |
| 5 | **Student boarding/attendance** | Parents often expect "child boarded/dropped" alerts. Not in scope. We'll treat it as a future add-on. |
| 6 | **Driver login method** | FRD says "credentials created by School Admin". We default to school code + mobile + password/PIN. |
| 7 | **Same driver in multiple schools** | We default to one account per school. |
| 8 | **Same child on both morning and afternoon routes** | We model assignment per direction. Confirm they can differ. |
| 9 | **Shift / backup driver rules** | Can the backup start a trip? Default yes, if assigned. |
| 10 | **Trip auto-generation vs manual** | Defaults to schedule-generated daily trips. Holidays/calendar? Provide a school holiday calendar (`school_holidays`) so we don't raise false "not started" alerts. |
| 11 | **Data retention** for location points and photos | Affects storage cost and privacy compliance. Default 12 months raw. |
| 12 | **Languages** | Hindi/English? Other regional languages? |
| 13 | **White-label** (school-branded apps vs one shared app) | One shared app with per-school branding inside is much cheaper than separate store listings per school. Confirm. |
| 14 | **Admin roles** | Single "school admin" role or sub-roles (transport in-charge, viewer)? Default: one role, with a hook for permissions later. |
| 15 | **Report formats** | Exact columns, PDF templates, scheduled email reports? |
| 16 | **Uptime/SLA and support model** | Drives infrastructure (single region vs HA). |
| 17 | **Odometer OCR** | Optional: auto-read the photo and compare with the typed value. Extra cost/accuracy risk. Default: manual entry + admin review. |
| 18 | **Super Admin visibility** | FRD allows tenant status and health only. We confirm there's no impersonation or data access, even for support. |
| 19 | **Ownership of data / exit terms** | When a school leaves, export and deletion procedure. |
| 20 | **Hosting region** | Data residency in India? Choose the cloud region accordingly. |

---

## 20. Recommended Additions for Us as a Vendor

These are not in the FRD, but they protect our business and are cheap to design in now.

1. **Subscription and limits per school** (`school_subscriptions`: plan, max buses/students, valid_until, modules enabled). The Super Admin can suspend on expiry. The API checks it in `resolveTenant`.
2. **Feature flags per school** (SMS, WhatsApp, harsh-driving, route deviation, reports) in `school_settings.features`, so we can sell tiers.
3. **Usage metering** (active buses, trips/month, SMS sent) visible to the Super Admin as **aggregates only**.
4. **School holiday calendar** to suppress false alerts.
5. **Support access ("break-glass")**: if ever needed, a time-boxed, audited, school-approved support grant. Off by default and absent from MVP so we keep the FRD's guarantee.
6. **Announcements**: school → drivers/parents broadcast (cheap and useful).
7. **App version gating**: `min_supported_version` in platform settings, so a broken driver app build can be force-updated.
8. **Data export per school** for offboarding or migration to a dedicated database.
9. **Super Admin 2FA** and a hardware-key option. This account is the single most valuable target.

---

### Appendix A – Example: creating a school (platform flow)

```
POST /api/v1/platform/schools
{
  "name": "Sunrise Public School", "code": "SUNRISE-GZB",
  "address": "...", "timezone": "Asia/Kolkata",
  "contact": { "name": "...", "phone": "...", "email": "..." },
  "admin": { "name": "Principal Office", "email": "admin@sunrise.edu", "temp_password": "auto" }
}
```

One transaction: insert `schools` → insert `school_settings` (defaults) → insert `users(role=school_admin, school_id)` → write platform audit → enqueue the welcome email. Then the school admin logs in at `/school`, completes the profile and starts setup.

### Appendix B – Example: parent tracking request (isolation walk-through)

1. Parent logs in with OTP → JWT (`role=parent`, `sub=parent_account_id`, no `school_id`).
2. `GET /parent/children` → server queries `student_parents` by account (a global table query allowed only for the parent role) → groups by school.
3. Parent taps child X (school S2) → `GET /parent/children/X/tracking` with `X-School-Id: S2`.
4. Middleware verifies an active link between parent and student X in S2, then `withTenant({schoolId: S2, actorId: parent, role: 'parent'})`.
5. RLS and the `parent_students_only` policy ensure only X's data is visible. The response DTO applies the school's `parent_visibility` and returns the live state from Redis key `live:S2:{tripId}`.
6. The socket join for `child:X:live` repeats the same checks.

### Appendix C – Definition of Done for "tenant safe"

- [ ] Every tenant table has `school_id NOT NULL` + RLS + FORCE RLS
- [ ] Isolation tests pass for every endpoint, socket room and file route
- [ ] No repository can obtain a connection without `withTenant`
- [ ] Redis keys, queues' job payloads and logs include `school_id`
- [ ] Reports, search and CSV import/export are all tenant-scoped
- [ ] Super Admin tokens return zero tenant rows by construction
- [ ] Deactivated school: logins, ingest, sockets and signed URLs all blocked within one token lifetime
