-- 006 · Students, parent links and per-direction bus/route/stop assignments (BP §4.6, §6.2,
-- §19 #8). Students never log in.

create table students (
  id            uuid primary key default uuid_v7(),
  school_id     uuid not null references schools (id),
  admission_no  text,
  full_name     text not null check (length(btrim(full_name)) between 1 and 200),
  class_name    text,
  section       text,
  roll_no       text,
  photo_file_id uuid,
  notes         text,                                       -- internal only
  is_active     boolean not null default true,
  deleted_at    timestamptz,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (school_id, id),
  foreign key (school_id, photo_file_id) references files (school_id, id)
);
create unique index students_admission_uq on students (school_id, admission_no) where deleted_at is null and admission_no is not null;
create index students_school_class_idx on students (school_id, class_name, section, full_name) where deleted_at is null;
create index students_school_name_idx on students (school_id, lower(full_name)) where deleted_at is null;

-- A student can only be linked to a parent the school knows (school_parents row of that school).
create table student_parents (
  school_id         uuid not null references schools (id),
  student_id        uuid not null,
  parent_account_id uuid not null,
  relation          text,
  is_primary        boolean not null default false,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  primary key (student_id, parent_account_id),
  unique (school_id, student_id, parent_account_id),
  foreign key (school_id, student_id) references students (school_id, id) on delete cascade,
  foreign key (school_id, parent_account_id) references school_parents (school_id, parent_account_id)
);
create index student_parents_parent_idx on student_parents (parent_account_id, school_id);
create index student_parents_school_idx on student_parents (school_id, student_id);

-- Per direction (morning pick-up / afternoon drop). valid_to is exclusive (NULL = open); the stop
-- must belong to the route and the route must run in the assignment's direction.
create table student_assignments (
  id             uuid primary key default uuid_v7(),
  school_id      uuid not null references schools (id),
  student_id     uuid not null,
  trip_direction text not null check (trip_direction in ('morning', 'afternoon')),
  bus_id         uuid not null,
  route_id       uuid not null,
  stop_id        uuid not null,
  valid_from     date not null default current_date,
  valid_to       date,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  foreign key (school_id, student_id) references students (school_id, id),
  foreign key (school_id, bus_id) references buses (school_id, id),
  foreign key (school_id, route_id, trip_direction) references routes (school_id, id, direction),
  foreign key (school_id, stop_id) references stops (school_id, id),
  foreign key (route_id, stop_id) references stops (route_id, id),
  constraint student_assignments_window_ck check (valid_to is null or valid_to >= valid_from)
);
-- one_open_assignment is created before the overlap exclusion so a second OPEN assignment reports
-- the BP constraint name (indexes are checked in creation order); the exclusion additionally keeps
-- the history free of overlapping windows.
create unique index one_open_assignment on student_assignments (student_id, trip_direction) where valid_to is null;
alter table student_assignments add constraint student_assignments_no_overlap exclude using gist (
  student_id with =, trip_direction with =, daterange(valid_from, valid_to, '[)') with &&);
create index student_assignments_bus_idx on student_assignments (school_id, bus_id, trip_direction) where valid_to is null;
create index student_assignments_route_idx on student_assignments (school_id, route_id, stop_id) where valid_to is null;
create index student_assignments_student_idx on student_assignments (school_id, student_id, valid_from desc);
