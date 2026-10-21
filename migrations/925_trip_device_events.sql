-- Trips / tracking (lane B range 925–949): device events of a trip, the location-permission and
-- clock-drift alert types (BP §9.6, §11.1, §14.3).
--
-- trip_device_events  one row per device event the driver app reported for a trip
--                     (POST /driver/trips/:id/events): GPS off, low battery, no network, mock location,
--                     location permission denied / restored, clock drift, harsh driving, breakdown. It
--                     feeds the trip timeline of GET /school/trips/:id. occurred_at is on the SERVER
--                     clock (corrected when the phone clock was off by more than the drift tolerance;
--                     device_occurred_at keeps what the phone sent). Rows carry coordinates, so the
--                     partition-maintenance job purges them with the location history (migration 926).
--                     Hidden from parents.
-- alerts.alert_type   + 'location_permission' (the app lost the location permission: tracking stops
--                     until the driver allows it again — not the same fault as 'gps_disabled')
--                     + 'clock_drift' (the phone clock is off by more than the tolerance; its location
--                     times are corrected, or rejected beyond the maximum correction).
-- Idempotent: every statement can run again.

alter table alerts drop constraint if exists alerts_alert_type_check;
alter table alerts add constraint alerts_alert_type_check
  check (alert_type in ('trip_not_started', 'odometer_gap', 'odometer_decrease', 'odometer_gps_mismatch',
                        'non_school_trip', 'doc_expiring', 'doc_expired', 'doc_missing', 'service_due',
                        'speeding', 'harsh_driving', 'route_deviation', 'long_stop', 'gps_disabled',
                        'low_battery', 'no_network', 'trip_auto_closed', 'location_permission', 'clock_drift'));

create table if not exists trip_device_events (
  id                 uuid primary key default uuid_v7(),
  school_id          uuid not null references schools (id),
  trip_id            uuid not null,
  event_type         text not null check (event_type in ('gps_disabled', 'low_battery', 'no_network', 'mock_location', 'trip_interrupted',
                                                         'harsh_braking', 'harsh_acceleration', 'harsh_cornering',
                                                         'location_permission_denied', 'location_permission_restored', 'clock_drift')),
  occurred_at        timestamptz not null,                     -- server clock (corrected)
  device_occurred_at timestamptz not null,                     -- as the phone sent it
  received_at        timestamptz not null default now(),
  clock_offset_ms    bigint,                                   -- server − device correction applied, NULL = none
  latitude           numeric(9,6) check (latitude between -90 and 90),
  longitude          numeric(9,6) check (longitude between -180 and 180),
  details            jsonb not null default '{}'::jsonb,       -- batteryPct, networkType, message, gForce, speedKmh, permission
  device_id          uuid,                                     -- devices.id of the bound phone
  reported_by        uuid,                                     -- users.id of the driver / conductor
  alert_id           uuid,                                     -- alert raised (or deduplicated into) by the event
  created_at         timestamptz not null default now(),
  foreign key (school_id, trip_id) references trips (school_id, id)
);
create index if not exists trip_device_events_trip_idx on trip_device_events (school_id, trip_id, occurred_at);

select apply_tenant_rls('trip_device_events');
select apply_parent_scope('trip_device_events', 'false');
