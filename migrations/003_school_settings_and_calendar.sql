-- 003 · School settings, holiday calendar and announcements (BP §6.2 school_settings, §13.3,
-- §19 #10, §20 #2/#4/#6; contract §9).

create table school_settings (
  school_id                      uuid primary key references schools (id),
  -- Location overrides (NULL = platform default)
  location_moving_interval_s     integer check (location_moving_interval_s is null or location_moving_interval_s >= 10),
  location_stopped_interval_s    integer check (location_stopped_interval_s is null or location_stopped_interval_s between 30 and 300),
  moving_speed_kmh               numeric(4,1) check (moving_speed_kmh is null or moving_speed_kmh between 0.5 and 30),
  stopped_after_s                integer check (stopped_after_s is null or stopped_after_s between 15 and 600),
  location_retention_months      integer check (location_retention_months is null or location_retention_months between 1 and 60),
  document_reminder_days         integer[] check (document_reminder_days is null or 0 < all (document_reminder_days)),
  -- Trips and odometer (BP §10)
  allow_non_school_trips         boolean not null default false,
  allow_backup_driver_start      boolean not null default true,
  odometer_gallery_allowed       boolean not null default false,
  odometer_mismatch_threshold_km numeric(6,1) not null default 5 check (odometer_mismatch_threshold_km >= 0),
  odometer_gps_variance_pct      numeric(5,2) not null default 15 check (odometer_gps_variance_pct between 0 and 100),
  odometer_gps_min_km            numeric(6,1) not null default 2 check (odometer_gps_min_km >= 0),
  trip_not_started_grace_min     integer not null default 10 check (trip_not_started_grace_min between 0 and 240),
  trip_delay_threshold_min       integer not null default 10 check (trip_delay_threshold_min between 1 and 240),
  stale_trip_close_hours         integer check (stale_trip_close_hours is null or stale_trip_close_hours between 1 and 48),
  -- Alerts (BP §11.1)
  stop_duration_alert_min        integer not null default 10 check (stop_duration_alert_min between 1 and 240),
  speed_limit_kmh                integer check (speed_limit_kmh is null or speed_limit_kmh between 10 and 150),
  enable_speeding_alert          boolean not null default false,
  enable_harsh_driving_alert     boolean not null default false,
  enable_route_deviation_alert   boolean not null default false,
  route_deviation_m              integer not null default 300 check (route_deviation_m between 50 and 5000),
  approaching_stop_minutes       integer not null default 5 check (approaching_stop_minutes between 1 and 60),
  notify_trip_not_started        boolean not null default true,
  alert_recipients               jsonb not null default '[]'::jsonb check (jsonb_typeof(alert_recipients) = 'array'),
  -- Commercial feature flags per school (BP §20 #2; contract §9)
  features                       jsonb not null default '{"sms": false, "whatsapp": false, "email_digest": false, "eta_v2": false, "route_deviation": true, "speeding": true, "harsh_driving": false, "reports": true, "announcements": true}'::jsonb
                                   check (jsonb_typeof(features) = 'object'),
  parent_visibility              jsonb not null default '{
    "bus":       {"capacity": false, "images": true, "plate": true,
                  "insurance_status": true, "insurance_file": false,
                  "fitness_status": true, "fitness_file": false},
    "driver":    {"photo": true, "phone": false, "email": false, "experience": true,
                  "licence_validity": true, "licence_file": false,
                  "training": true, "character_cert_status": true, "verification": true},
    "conductor": {"photo": true, "phone": false, "email": false, "experience": true,
                  "verification": true, "character_cert_status": true, "training": true}
  }'::jsonb check (jsonb_typeof(parent_visibility) = 'object'),
  updated_by                     uuid,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now()
);

-- Every school gets its settings row in the same transaction as the school (BP App. A). The
-- trigger switches app.school_id to the new school for its own insert (tenant_isolation applies)
-- and restores the caller's value, so it works from the super-admin context and from seeds.
create or replace function schools_create_settings() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_prev text := coalesce(current_setting('app.school_id', true), '');
begin
  perform set_config('app.school_id', new.id::text, true);
  insert into school_settings (school_id) values (new.id) on conflict (school_id) do nothing;
  perform set_config('app.school_id', v_prev, true);
  return new;
end
$$;
create trigger schools_create_settings after insert on schools
  for each row execute function schools_create_settings();

-- School admins may edit their school profile, never its platform-controlled columns.
create or replace function schools_guard_platform_columns() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('app.actor_role', true), '') not in ('', 'super_admin', 'system')
     and (new.code, new.status, new.status_reason, new.institution_type, new.tenant_mode, new.db_connection_ref,
          new.storage_prefix, new.realtime_shard, new.deleted_at, new.created_by)
         is distinct from
         (old.code, old.status, old.status_reason, old.institution_type, old.tenant_mode, old.db_connection_ref,
          old.storage_prefix, old.realtime_shard, old.deleted_at, old.created_by) then
    raise exception 'Only the platform can change these school fields' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger schools_guard_platform_columns before update on schools
  for each row execute function schools_guard_platform_columns();

-- ───────────── school_holidays (no trips generated, no "not started" alerts) ─────────────
create table school_holidays (
  id         uuid primary key default uuid_v7(),
  school_id  uuid not null references schools (id),
  name       text not null check (length(btrim(name)) between 1 and 200),
  start_date date not null,
  end_date   date not null,                           -- inclusive
  applies_to text not null default 'all' check (applies_to in ('all', 'morning', 'afternoon')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint school_holidays_range_ck check (end_date >= start_date)
);
create index school_holidays_school_dates_idx on school_holidays (school_id, start_date, end_date);

-- ───────────── announcements (school → drivers / parents) ─────────────
create table announcements (
  id           uuid primary key default uuid_v7(),
  school_id    uuid not null references schools (id),
  title        text not null check (length(btrim(title)) between 1 and 200),
  body         text not null check (length(body) <= 5000),
  audience     text not null default 'all' check (audience in ('drivers', 'parents', 'all')),
  is_pinned    boolean not null default false,
  published_at timestamptz not null default now(),
  expires_at   timestamptz,
  created_by   uuid,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint announcements_window_ck check (expires_at is null or expires_at > published_at)
);
create index announcements_school_published_idx on announcements (school_id, published_at desc) where deleted_at is null;
