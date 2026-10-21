-- 002 · Platform tables, schools and school-level configuration (BP §4.4, §4.7, §6.2, §20;
-- contract §4, §9). Platform tables carry no school_id; schools is the tenant registry.

-- ───────────── platform_users (super admins) ─────────────
create table platform_users (
  id                   uuid primary key default uuid_v7(),
  email                citext not null unique,
  name                 text not null check (length(btrim(name)) between 1 and 200),
  password_hash        text not null,
  must_change_password boolean not null default false,
  -- TOTP (contract §2): secret encrypted by the API (encryptSecret); enabled after /totp/verify.
  totp_secret_enc      text,
  totp_enabled         boolean not null default false,
  totp_enrolled_at     timestamptz,
  totp_last_used_step  bigint,                      -- replay protection for TOTP codes
  is_active            boolean not null default true,
  failed_login_count   integer not null default 0 check (failed_login_count >= 0),
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint platform_users_totp_ck check (not totp_enabled or totp_secret_enc is not null)
);

-- ───────────── schools (tenants) ─────────────
create table schools (
  id                uuid primary key default uuid_v7(),
  code              text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),  -- login code, e.g. GWIS-BLR
  name              text not null check (length(btrim(name)) between 1 and 200),
  institution_type  text not null default 'school' check (institution_type in ('school', 'college', 'university')),
  address           text,
  city              text,
  state             text,
  pincode           text,
  contact_name      text,
  contact_phone     text,
  contact_email     citext,
  logo_file_id      uuid,                             -- FK added with the files table
  brand_color       text check (brand_color is null or brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  latitude          numeric(9,6) check (latitude between -90 and 90),
  longitude         numeric(9,6) check (longitude between -180 and 180),
  geom              geography(Point, 4326) generated always as (
                      case when latitude is not null and longitude is not null
                           then st_setsrid(st_makepoint(longitude::float8, latitude::float8), 4326)::geography end
                    ) stored,
  geofence_radius_m integer not null default 150 check (geofence_radius_m between 20 and 5000),
  timezone          text not null default 'Asia/Kolkata',
  status            text not null default 'active' check (status in ('active', 'suspended', 'inactive')),
  status_reason     text,
  -- Dedicated-tenant hooks (BP §4.7)
  tenant_mode       text not null default 'shared' check (tenant_mode in ('shared', 'dedicated')),
  db_connection_ref text,
  storage_prefix    text,
  realtime_shard    text,
  deleted_at        timestamptz,
  created_by        uuid references platform_users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint schools_location_ck check ((latitude is null) = (longitude is null)),
  constraint schools_dedicated_ck check (tenant_mode = 'shared' or db_connection_ref is not null)
);
create unique index schools_code_uq on schools (code);
create index schools_status_idx on schools (status) where deleted_at is null;
create index schools_name_idx on schools (lower(name));

-- ───────────── files (BP §12) — registry of every stored object ─────────────
create table files (
  id            uuid primary key default uuid_v7(),
  school_id     uuid not null references schools (id),
  key           text not null unique,                -- <S3_KEY_PREFIX>schools/{school_id}/{category}/{entity_id}/{uuid}.{ext}
  thumb_key     text,
  category      text not null check (category in ('school_logo', 'bus_image', 'bus_document', 'staff_photo', 'staff_document',
                                                  'student_photo', 'odometer', 'fuel_bill', 'maintenance_invoice', 'import', 'report')),
  entity_type   text check (entity_type in ('school', 'bus', 'staff', 'student', 'trip', 'fuel_log', 'maintenance_log', 'import', 'report')),
  entity_id     uuid,
  mime          text not null,
  size_bytes    bigint check (size_bytes is null or size_bytes >= 0),
  sha256        text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  original_name text,
  metadata      jsonb not null default '{}'::jsonb,   -- capture time/GPS, dimensions, scan result
  status        text not null default 'pending' check (status in ('pending', 'uploaded', 'rejected', 'deleted')),
  uploaded_by   uuid,
  uploader_type text check (uploader_type in ('user', 'parent_account', 'platform_user', 'system')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (school_id, id)
);
create index files_school_entity_idx on files (school_id, entity_type, entity_id);
create index files_school_created_idx on files (school_id, created_at desc);
create index files_pending_idx on files (created_at) where status = 'pending';

alter table schools
  add constraint schools_logo_file_fk foreign key (id, logo_file_id) references files (school_id, id);

-- ───────────── platform_settings (global defaults) ─────────────
create table platform_settings (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  value       jsonb not null,
  description text,
  is_public   boolean not null default false,        -- readable by every authenticated context
  updated_by  uuid,                                    -- platform_users.id (pointer only, survives user removal)
  updated_at  timestamptz not null default now()
);

-- Defaults (kept identical to src/db/platformDefaults.ts — a test compares them).
insert into platform_settings (key, value, description, is_public) values
  ('location.moving_interval_s',  '10',  'Seconds between location updates while moving (hard floor 10)', true),
  ('location.stopped_interval_s', '90',  'Seconds between location updates while stopped (60-120)', true),
  ('location.moving_speed_kmh',   '4',   'Speed above which the bus counts as moving', true),
  ('location.stopped_after_s',    '60',  'Seconds at or below the moving speed before the bus counts as stopped', true),
  ('location.stale_after_s',      '45',  'Age after which a live position shows "Location unavailable"', true),
  ('location.retention_months',   '12',  'Months of raw location points kept before partitions are dropped', false),
  ('docs.expiry_reminder_days',   '[60, 30, 15, 7, 1]', 'Days before expiry at which document reminders are raised', true),
  ('trips.stale_close_hours',     '3',   'Hours without location data before an in-progress trip is auto-closed', false),
  ('trips.late_points_hours',     '24',  'Hours after the end of a trip during which backfilled points are accepted', true),
  ('min_supported_version',       '{"driver_app": "1.0.0", "parent_app": "1.0.0"}', 'Minimum app version per client application', true),
  ('modules',                     '{"push": true, "sms": false, "whatsapp": false, "email": true}', 'Platform-wide notification modules', true),
  ('features',                    '{"eta_v2": false, "route_deviation": true, "speeding": true, "harsh_driving": false, "reports": true, "announcements": true}', 'Platform-wide feature flags (schools can only narrow them)', true);

-- ───────────── school_subscriptions (BP §20 #1) ─────────────
create table school_subscriptions (
  id           uuid primary key default uuid_v7(),
  school_id    uuid not null references schools (id),
  plan         text not null default 'standard' check (length(btrim(plan)) between 1 and 60),
  status       text not null default 'active' check (status in ('active', 'expired', 'cancelled')),
  max_buses    integer check (max_buses is null or max_buses >= 0),
  max_students integer check (max_students is null or max_students >= 0),
  modules      jsonb not null default '{}'::jsonb,
  valid_from   date not null default current_date,
  valid_until  date,
  notes        text,
  created_by   uuid references platform_users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint school_subscriptions_window_ck check (valid_until is null or valid_until >= valid_from)
);
create unique index school_subscriptions_one_active on school_subscriptions (school_id) where status = 'active';
create index school_subscriptions_school_idx on school_subscriptions (school_id, created_at desc);
