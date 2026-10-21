-- Notifications (lane B range 850–899): parent notices for trip disruptions (BP §10.4 bus breakdown —
-- "Driver can mark Trip interrupted and the school can cancel. Parents are notified if enabled.").
--   trip_interrupted  the driver marked the running trip interrupted (POST /driver/trips/:id/interrupt
--                     or a 'trip_interrupted' device event)
--   trip_cancelled    the school cancelled a running trip, or today's trip before it started
-- They use the same pipeline as the BP §11.2 events: one notification_events row per (trip, student,
-- event) as the dedupe authority, inbox rows in parent_notifications, and per parent / child / direction
-- opt-outs in notification_preferences (default on, like every other event).
alter table notification_preferences
  add column trip_interrupted boolean not null default true,
  add column trip_cancelled   boolean not null default true;

alter table notification_events drop constraint if exists notification_events_event_type_check;
alter table notification_events add constraint notification_events_event_type_check
  check (event_type in ('trip_started', 'bus_left_school', 'approaching_stop', 'arrived_at_stop', 'trip_delayed', 'trip_not_started',
                        'trip_interrupted', 'trip_cancelled'));

alter table parent_notifications drop constraint if exists parent_notifications_kind_check;
alter table parent_notifications add constraint parent_notifications_kind_check
  check (kind in ('trip_started', 'bus_left_school', 'approaching_stop', 'arrived_at_stop', 'trip_delayed', 'trip_not_started',
                  'trip_interrupted', 'trip_cancelled', 'announcement', 'system'));
