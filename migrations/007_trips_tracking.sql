-- 007 · Trips, odometer evidence, partitioned location points and stop events (BP §6.2, §6.3,
-- §9, §10; contract §3, §8).

create table trips (
  id                       uuid primary key default uuid_v7(),
  school_id                uuid not null references schools (id),
  schedule_id              uuid,
  trip_type                text not null default 'school' check (trip_type in ('school', 'non_school')),
  direction                text check (direction in ('morning', 'afternoon')),
  trip_date                date not null,                      -- school-local date
  bus_id                   uuid not null,
  route_id                 uuid,
  driver_staff_id          uuid,                               -- snapshot at creation / start
  conductor_staff_id       uuid,
  -- Snapshots survive later renames and reassignments
  bus_code_snapshot        text,
  bus_registration_snapshot text,
  route_code_snapshot      text,
  route_name_snapshot      text,
  driver_name_snapshot     text,
  conductor_name_snapshot  text,
  status                   text not null default 'scheduled'
                             check (status in ('scheduled', 'in_progress', 'completed', 'missed', 'cancelled', 'auto_closed')),
  planned_start_at         timestamptz,
  started_at               timestamptz,
  ended_at                 timestamptz,
  start_device_time        timestamptz,
  end_device_time          timestamptz,
  start_lat                numeric(9,6) check (start_lat between -90 and 90),
  start_lng                numeric(9,6) check (start_lng between -180 and 180),
  end_lat                  numeric(9,6) check (end_lat between -90 and 90),
  end_lng                  numeric(9,6) check (end_lng between -180 and 180),
  start_odometer           numeric(10,1) check (start_odometer >= 0),
  end_odometer             numeric(10,1) check (end_odometer >= 0),
  distance_odometer_km     numeric(8,1) check (distance_odometer_km >= 0),
  distance_gps_km          numeric(8,1) check (distance_gps_km >= 0),
  odometer_correction      jsonb,                              -- admin correction {original, corrected, reason, by, at}
  purpose                  text,                               -- required for non_school
  device_id                uuid,                               -- trip bound to the start device
  started_by               uuid,
  ended_by                 uuid,
  cancelled_by             uuid,
  cancel_reason            text,
  close_reason             text,                               -- auto_closed / interrupted explanation
  interrupted_at           timestamptz,
  last_point_at            timestamptz,                        -- newest accepted point (gap / stale detection)
  points_count             integer not null default 0 check (points_count >= 0),
  client_start_id          uuid unique,                        -- idempotency key from the driver app
  summary                  jsonb,                              -- trip-finalizer analytics
  finalized_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (school_id, id),
  foreign key (school_id, schedule_id) references trip_schedules (school_id, id),
  foreign key (school_id, bus_id) references buses (school_id, id),
  foreign key (school_id, route_id) references routes (school_id, id),
  foreign key (school_id, driver_staff_id) references staff_profiles (school_id, id),
  foreign key (school_id, conductor_staff_id) references staff_profiles (school_id, id),
  foreign key (school_id, started_by) references users (school_id, id),
  foreign key (school_id, ended_by) references users (school_id, id),
  foreign key (school_id, cancelled_by) references users (school_id, id),
  foreign key (school_id, device_id) references devices (school_id, id),
  constraint trips_school_trip_ck check (trip_type <> 'school' or direction is not null),
  constraint trips_non_school_purpose_ck check (trip_type <> 'non_school' or length(btrim(coalesce(purpose, ''))) > 0),
  constraint trips_started_ck check (status not in ('in_progress', 'completed', 'auto_closed') or started_at is not null),
  constraint trips_ended_ck check (status not in ('completed', 'auto_closed') or ended_at is not null),
  constraint trips_time_order_ck check (ended_at is null or started_at is null or ended_at >= started_at),
  constraint trips_odometer_order_ck check (end_odometer is null or start_odometer is null or end_odometer >= start_odometer)
);
create unique index one_active_trip_per_bus on trips (bus_id) where status = 'in_progress';
create unique index one_active_trip_per_driver on trips (driver_staff_id) where status = 'in_progress' and driver_staff_id is not null;
create unique index one_active_trip_per_conductor on trips (conductor_staff_id) where status = 'in_progress' and conductor_staff_id is not null;
create unique index trips_schedule_date_uq on trips (schedule_id, trip_date) where schedule_id is not null;
create index trips_school_date on trips (school_id, trip_date desc);
create index trips_active on trips (school_id) where status = 'in_progress';
create index trips_school_bus_date_idx on trips (school_id, bus_id, trip_date desc);
create index trips_school_status_date_idx on trips (school_id, status, trip_date desc);
create index trips_school_driver_date_idx on trips (school_id, driver_staff_id, trip_date desc) where driver_staff_id is not null;
create index trips_school_route_date_idx on trips (school_id, route_id, trip_date desc) where route_id is not null;
create index trips_scheduled_start_idx on trips (school_id, planned_start_at) where status = 'scheduled';
create index trips_bus_closed_idx on trips (bus_id, ended_at desc) where status in ('completed', 'auto_closed');

create table trip_odometer_evidence (
  id            uuid primary key default uuid_v7(),
  school_id     uuid not null references schools (id),
  trip_id       uuid not null,
  kind          text not null check (kind in ('start', 'end', 'place')),
  reading       numeric(10,1) check (reading >= 0),
  file_id       uuid not null,
  captured_at   timestamptz not null,                          -- device time
  received_at   timestamptz not null default now(),
  latitude      numeric(9,6) check (latitude between -90 and 90),
  longitude     numeric(9,6) check (longitude between -180 and 180),
  accuracy_m    real,
  sha256        text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  source        text not null default 'camera' check (source in ('camera', 'gallery')),
  device_id     uuid,
  recorded_by   uuid,
  created_at    timestamptz not null default now(),
  foreign key (school_id, trip_id) references trips (school_id, id),
  foreign key (school_id, file_id) references files (school_id, id),
  foreign key (school_id, recorded_by) references users (school_id, id),
  foreign key (school_id, device_id) references devices (school_id, id)
);
create unique index trip_odometer_evidence_one_per_kind on trip_odometer_evidence (trip_id, kind) where kind in ('start', 'end');
create index trip_odometer_evidence_trip_idx on trip_odometer_evidence (school_id, trip_id);

-- High volume: monthly range partitions on the device timestamp (BP §6.3). PK (trip_id,
-- recorded_at) makes batch retries idempotent (INSERT … ON CONFLICT DO NOTHING).
create table location_points (
  school_id     uuid not null,
  trip_id       uuid not null,
  recorded_at   timestamptz not null,                          -- device timestamp (original)
  received_at   timestamptz not null default now(),
  latitude      double precision not null check (latitude between -90 and 90),
  longitude     double precision not null check (longitude between -180 and 180),
  speed_kmh     real check (speed_kmh is null or speed_kmh >= 0),
  heading       real check (heading is null or (heading >= 0 and heading < 360)),
  accuracy_m    real check (accuracy_m is null or accuracy_m >= 0),
  battery_pct   smallint check (battery_pct is null or battery_pct between 0 and 100),
  network_type  text,
  is_moving     boolean,
  is_backfilled boolean not null default false,
  primary key (trip_id, recorded_at),
  foreign key (school_id, trip_id) references trips (school_id, id)
) partition by range (recorded_at);

create table trip_stop_events (
  id          uuid primary key default uuid_v7(),
  school_id   uuid not null references schools (id),
  trip_id     uuid not null,
  stop_id     uuid not null,
  arrived_at  timestamptz,
  departed_at timestamptz,
  dwell_s     integer check (dwell_s is null or dwell_s >= 0),
  distance_m  real,                                            -- closest approach to the stop
  source      text not null default 'live' check (source in ('live', 'finalizer', 'manual')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (trip_id, stop_id),
  foreign key (school_id, trip_id) references trips (school_id, id),
  foreign key (school_id, stop_id) references stops (school_id, id),
  constraint trip_stop_events_order_ck check (departed_at is null or arrived_at is null or departed_at >= arrived_at)
);
create index trip_stop_events_trip_idx on trip_stop_events (school_id, trip_id, arrived_at);
