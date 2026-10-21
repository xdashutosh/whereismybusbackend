-- 008 · Alerts, fuel and maintenance logs, parent notification preferences, sent-notification
-- dedupe and the parent in-app inbox (BP §6.2, §11; contract §2 Push, §9).

create table alerts (
  id           uuid primary key default uuid_v7(),
  school_id    uuid not null references schools (id),
  alert_type   text not null check (alert_type in ('trip_not_started', 'odometer_gap', 'odometer_decrease', 'odometer_gps_mismatch',
                                                   'non_school_trip', 'doc_expiring', 'doc_expired', 'doc_missing', 'service_due',
                                                   'speeding', 'harsh_driving', 'route_deviation', 'long_stop', 'gps_disabled',
                                                   'low_battery', 'no_network', 'trip_auto_closed')),
  severity     text not null check (severity in ('info', 'warning', 'critical')),
  entity_type  text check (entity_type is null or entity_type in ('bus', 'trip', 'staff', 'bus_document', 'staff_document', 'maintenance_log', 'device')),
  entity_id    uuid,
  trip_id      uuid,
  bus_id       uuid,
  staff_id     uuid,
  title        text not null check (length(btrim(title)) between 1 and 300),
  details      jsonb not null default '{}'::jsonb,
  dedupe_key   text,                                           -- e.g. doc_expiring:{doc_id}:{threshold}
  status       text not null default 'open' check (status in ('open', 'reviewed', 'escalated', 'closed')),
  reviewed_by  uuid,
  reviewed_at  timestamptz,
  review_note  text,
  escalated_by uuid,
  escalated_at timestamptz,
  closed_by    uuid,
  closed_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (school_id, trip_id) references trips (school_id, id),
  foreign key (school_id, bus_id) references buses (school_id, id),
  foreign key (school_id, staff_id) references staff_profiles (school_id, id),
  foreign key (school_id, reviewed_by) references users (school_id, id),
  foreign key (school_id, escalated_by) references users (school_id, id),
  foreign key (school_id, closed_by) references users (school_id, id)
);
-- Repeated scans/ingest never duplicate an open (or escalated) alert.
create unique index alerts_dedupe on alerts (school_id, dedupe_key) where status in ('open', 'escalated');
create index alerts_school_status_idx on alerts (school_id, status, created_at desc);
create index alerts_school_type_idx on alerts (school_id, alert_type, created_at desc);
create index alerts_school_created_idx on alerts (school_id, created_at desc);
create index alerts_trip_idx on alerts (school_id, trip_id) where trip_id is not null;
create index alerts_bus_idx on alerts (school_id, bus_id, created_at desc) where bus_id is not null;

create table fuel_logs (
  id           uuid primary key default uuid_v7(),
  school_id    uuid not null references schools (id),
  bus_id       uuid not null,
  fuel_date    date not null,
  odometer     numeric(10,1) check (odometer is null or odometer >= 0),
  litres       numeric(8,2) not null check (litres > 0),
  cost         numeric(10,2) not null check (cost >= 0),
  fuel_type    text check (fuel_type is null or fuel_type in ('diesel', 'petrol', 'cng', 'electric', 'hybrid', 'other')),
  station      text,
  bill_file_id uuid,
  notes        text,
  deleted_at   timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (school_id, bus_id) references buses (school_id, id),
  foreign key (school_id, bill_file_id) references files (school_id, id)
);
create index fuel_logs_school_date_idx on fuel_logs (school_id, fuel_date desc) where deleted_at is null;
create index fuel_logs_school_bus_date_idx on fuel_logs (school_id, bus_id, fuel_date desc) where deleted_at is null;

create table maintenance_logs (
  id              uuid primary key default uuid_v7(),
  school_id       uuid not null references schools (id),
  bus_id          uuid not null,
  service_type    text not null check (length(btrim(service_type)) between 1 and 100),
  service_date    date not null,
  cost            numeric(10,2) check (cost is null or cost >= 0),
  odometer        numeric(10,1) check (odometer is null or odometer >= 0),
  vendor          text,
  notes           text,
  invoice_file_id uuid,
  next_due_date   date,
  next_due_km     numeric(10,1) check (next_due_km is null or next_due_km >= 0),
  deleted_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (school_id, bus_id) references buses (school_id, id),
  foreign key (school_id, invoice_file_id) references files (school_id, id)
);
create index maintenance_logs_school_date_idx on maintenance_logs (school_id, service_date desc) where deleted_at is null;
create index maintenance_logs_school_bus_idx on maintenance_logs (school_id, bus_id, service_date desc) where deleted_at is null;
create index maintenance_logs_due_idx on maintenance_logs (school_id, next_due_date) where deleted_at is null and next_due_date is not null;

-- Per parent, child and direction (BP §11.2); a missing row means "all enabled".
create table notification_preferences (
  school_id         uuid not null references schools (id),
  parent_account_id uuid not null,
  student_id        uuid not null,
  direction         text not null check (direction in ('morning', 'afternoon')),
  trip_started      boolean not null default true,
  bus_left_school   boolean not null default true,
  approaching_stop  boolean not null default true,
  arrived_at_stop   boolean not null default true,
  trip_delayed      boolean not null default true,
  trip_not_started  boolean not null default true,
  updated_at        timestamptz not null default now(),
  primary key (student_id, parent_account_id, direction),
  foreign key (school_id, student_id, parent_account_id) references student_parents (school_id, student_id, parent_account_id) on delete cascade
);
create index notification_preferences_parent_idx on notification_preferences (school_id, parent_account_id);

-- Dedupe + record of what was sent: one event per trip, student and event type.
create table notification_events (
  id         uuid primary key default uuid_v7(),
  school_id  uuid not null references schools (id),
  trip_id    uuid not null,
  student_id uuid,
  event_type text not null check (event_type in ('trip_started', 'bus_left_school', 'approaching_stop', 'arrived_at_stop', 'trip_delayed', 'trip_not_started')),
  channel    text not null default 'push' check (channel in ('push', 'sms', 'whatsapp', 'email', 'in_app')),
  status     text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  payload    jsonb not null default '{}'::jsonb,
  error      text,
  sent_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (school_id, id),
  constraint notification_events_dedupe unique (trip_id, student_id, event_type),
  foreign key (school_id, trip_id) references trips (school_id, id),
  foreign key (school_id, student_id) references students (school_id, id)
);
create index notification_events_school_created_idx on notification_events (school_id, created_at desc);

-- Parent in-app inbox (contract §2 Push): works without FCM.
create table parent_notifications (
  id                    uuid primary key default uuid_v7(),
  school_id             uuid not null references schools (id),
  parent_account_id     uuid not null references parent_accounts (id),
  student_id            uuid,
  trip_id               uuid,
  notification_event_id uuid,
  kind                  text not null check (kind in ('trip_started', 'bus_left_school', 'approaching_stop', 'arrived_at_stop',
                                                     'trip_delayed', 'trip_not_started', 'announcement', 'system')),
  title                 text not null check (length(btrim(title)) between 1 and 200),
  body                  text not null check (length(body) <= 2000),
  data                  jsonb not null default '{}'::jsonb,       -- deep-link payload (no sensitive data)
  read_at               timestamptz,
  created_at            timestamptz not null default now(),
  foreign key (school_id, student_id) references students (school_id, id),
  foreign key (school_id, trip_id) references trips (school_id, id),
  foreign key (school_id, notification_event_id) references notification_events (school_id, id),
  constraint parent_notifications_event_uq unique (notification_event_id, parent_account_id)
);
create index parent_notifications_inbox_idx on parent_notifications (parent_account_id, created_at desc);
create index parent_notifications_unread_idx on parent_notifications (parent_account_id) where read_at is null;
create index parent_notifications_school_idx on parent_notifications (school_id, created_at desc);
