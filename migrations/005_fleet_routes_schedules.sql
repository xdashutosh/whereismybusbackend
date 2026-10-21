-- 005 · Fleet (buses, images, documents, staff assignments), routes, stops, bus↔route assignments
-- and trip schedules (BP §6.2). Composite foreign keys (school_id, x_id) → x(school_id, id) make
-- cross-tenant references impossible even for ids guessed by a client.

create table buses (
  id                  uuid primary key default uuid_v7(),
  school_id           uuid not null references schools (id),
  code                text not null check (length(btrim(code)) between 1 and 40),     -- 'R1', 'Green Van' (parent-visible)
  display_name        text,
  vehicle_type        text check (vehicle_type is null or vehicle_type in ('bus', 'mini_bus', 'van', 'car', 'other')),
  make_model          text,
  manufacture_year    integer check (manufacture_year is null or manufacture_year between 1980 and 2100),
  color               text,
  capacity            integer check (capacity is null or capacity between 1 and 200),
  registration_no     text not null check (length(btrim(registration_no)) between 4 and 20),
  fuel_type           text check (fuel_type is null or fuel_type in ('diesel', 'petrol', 'cng', 'electric', 'hybrid', 'other')),
  status              text not null default 'active' check (status in ('active', 'maintenance', 'retired', 'inactive')),
  last_known_odometer numeric(10,1) check (last_known_odometer is null or last_known_odometer >= 0),
  odometer_updated_at timestamptz,
  notes               text,
  deleted_at          timestamptz,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (school_id, id)
);
create unique index buses_code_uq on buses (school_id, code) where deleted_at is null;
create unique index buses_registration_uq on buses (school_id, upper(registration_no)) where deleted_at is null;
create index buses_school_status_idx on buses (school_id, status) where deleted_at is null;

create table bus_images (
  id         uuid primary key default uuid_v7(),
  school_id  uuid not null references schools (id),
  bus_id     uuid not null,
  file_id    uuid not null,
  caption    text,
  sort_order integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (school_id, bus_id) references buses (school_id, id) on delete cascade,
  foreign key (school_id, file_id) references files (school_id, id)
);
create index bus_images_bus_idx on bus_images (school_id, bus_id, sort_order);

create table bus_documents (
  id                        uuid primary key default uuid_v7(),
  school_id                 uuid not null references schools (id),
  bus_id                    uuid not null,
  doc_type                  text not null check (doc_type in ('insurance', 'fitness', 'pollution', 'permit', 'rc', 'safety_inspection', 'other')),
  title                     text,
  issuer                    text,
  doc_number                text,
  start_date                date,
  expiry_date               date,
  file_id                   uuid,
  verification_status       text not null default 'pending' check (verification_status in ('pending', 'verified', 'rejected')),
  verified_by               uuid,
  verified_at               timestamptz,
  verification_note         text,
  visible_to_parents_status boolean not null default true,     -- show validity only
  visible_to_parents_file   boolean not null default false,    -- show the file
  is_current                boolean not null default true,     -- replaced documents stay as history
  replaced_by               uuid,
  deleted_at                timestamptz,
  created_by                uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (school_id, id),
  foreign key (school_id, bus_id) references buses (school_id, id),
  foreign key (school_id, file_id) references files (school_id, id),
  constraint bus_documents_dates_ck check (expiry_date is null or start_date is null or expiry_date >= start_date)
);
create index bus_documents_bus_idx on bus_documents (school_id, bus_id, doc_type) where deleted_at is null;
create index bus_documents_expiry_idx on bus_documents (school_id, expiry_date) where is_current and deleted_at is null and expiry_date is not null;
create unique index bus_documents_one_current on bus_documents (bus_id, doc_type) where is_current and deleted_at is null and doc_type <> 'other';

-- Historic staff assignments: past trips show who was valid at that time.
create table bus_staff_assignments (
  id              uuid primary key default uuid_v7(),
  school_id       uuid not null references schools (id),
  bus_id          uuid not null,
  staff_id        uuid not null,
  assignment_role text not null check (assignment_role in ('primary_driver', 'backup_driver', 'conductor', 'backup_conductor')),
  valid_from      timestamptz not null default now(),
  valid_to        timestamptz,                                -- exclusive; NULL = open
  created_by      uuid,
  created_at      timestamptz not null default now(),
  foreign key (school_id, bus_id) references buses (school_id, id),
  foreign key (school_id, staff_id) references staff_profiles (school_id, id),
  constraint bus_staff_assignments_window_ck check (valid_to is null or valid_to >= valid_from)
);
-- At most one open primary driver per bus (created before the overlap exclusion → reported first).
create unique index one_primary_driver on bus_staff_assignments (bus_id) where assignment_role = 'primary_driver' and valid_to is null;
alter table bus_staff_assignments add constraint bus_staff_assignments_no_overlap exclude using gist (
  bus_id with =, staff_id with =, tstzrange(valid_from, valid_to, '[)') with &&);
create index bus_staff_assignments_bus_idx on bus_staff_assignments (school_id, bus_id, valid_from desc);
create index bus_staff_assignments_staff_idx on bus_staff_assignments (school_id, staff_id, valid_from desc);

create table routes (
  id                   uuid primary key default uuid_v7(),
  school_id            uuid not null references schools (id),
  code                 text not null check (length(btrim(code)) between 1 and 40),
  name                 text,
  direction            text not null check (direction in ('morning', 'afternoon')),
  description          text,
  is_active            boolean not null default true,
  polyline_encoded     text,                                    -- planned path (Google Routes or straight line)
  polyline_source      text check (polyline_source is null or polyline_source in ('google', 'straight')),
  polyline_computed_at timestamptz,
  distance_m           integer check (distance_m is null or distance_m >= 0),
  duration_s           integer check (duration_s is null or duration_s >= 0),
  deleted_at           timestamptz,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (school_id, id),
  unique (school_id, id, direction),
  constraint routes_polyline_ck check ((polyline_encoded is null) = (polyline_source is null))
);
create unique index routes_code_uq on routes (school_id, code, direction) where deleted_at is null;
create index routes_school_active_idx on routes (school_id, is_active, direction) where deleted_at is null;

create table stops (
  id               uuid primary key default uuid_v7(),
  school_id        uuid not null references schools (id),
  route_id         uuid not null,
  code             text,
  name             text not null check (length(btrim(name)) between 1 and 200),
  landmark         text,
  sequence         integer not null check (sequence >= 1),
  latitude         numeric(9,6) not null check (latitude between -90 and 90),
  longitude        numeric(9,6) not null check (longitude between -180 and 180),
  geom             geography(Point, 4326) generated always as
                     (st_setsrid(st_makepoint(longitude::float8, latitude::float8), 4326)::geography) stored,
  expected_time    time,
  arrival_radius_m integer not null default 100 check (arrival_radius_m between 20 and 2000),
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (school_id, id),
  unique (route_id, id),
  foreign key (school_id, route_id) references routes (school_id, id),
  -- One live stop per sequence; deferrable so a reorder can permute sequences in one statement.
  constraint stops_route_sequence_uq exclude using btree (route_id with =, sequence with =)
    where (deleted_at is null) deferrable initially immediate
);
create index stops_route_idx on stops (school_id, route_id, sequence) where deleted_at is null;
create index stops_geom_idx on stops using gist (geom);

create table bus_route_assignments (
  id         uuid primary key default uuid_v7(),
  school_id  uuid not null references schools (id),
  bus_id     uuid not null,
  route_id   uuid not null,
  valid_from timestamptz not null default now(),
  valid_to   timestamptz,                                       -- exclusive; NULL = open
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (school_id, bus_id) references buses (school_id, id),
  foreign key (school_id, route_id) references routes (school_id, id),
  constraint bus_route_assignments_window_ck check (valid_to is null or valid_to >= valid_from),
  constraint bus_route_assignments_no_overlap exclude using gist (
    bus_id with =, route_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
);
create index bus_route_assignments_bus_idx on bus_route_assignments (school_id, bus_id, valid_from desc);
create index bus_route_assignments_route_idx on bus_route_assignments (school_id, route_id, valid_from desc);

-- Recurring plan → generate-daily-trips creates one trip per schedule and local date.
create table trip_schedules (
  id                 uuid primary key default uuid_v7(),
  school_id          uuid not null references schools (id),
  bus_id             uuid not null,
  route_id           uuid not null,
  direction          text not null check (direction in ('morning', 'afternoon')),
  name               text,
  planned_start_time time not null,
  days_of_week       smallint[] not null default '{1,2,3,4,5,6}' -- ISO weekday: 1 = Monday … 7 = Sunday
                       check (cardinality(days_of_week) between 1 and 7 and days_of_week <@ '{1,2,3,4,5,6,7}'::smallint[]),
  valid_from         date,
  valid_to           date,                                        -- inclusive last day
  is_active          boolean not null default true,
  deleted_at         timestamptz,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (school_id, id),
  foreign key (school_id, bus_id) references buses (school_id, id),
  foreign key (school_id, route_id, direction) references routes (school_id, id, direction),
  constraint trip_schedules_window_ck check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
create index trip_schedules_school_idx on trip_schedules (school_id, is_active, direction) where deleted_at is null;
create index trip_schedules_bus_idx on trip_schedules (school_id, bus_id) where deleted_at is null;
