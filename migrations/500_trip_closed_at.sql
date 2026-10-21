-- Trips/tracking (range 500–599): server instant a RUNNING trip was closed — completed by the driver,
-- auto-closed by stale-trip-closer, or cancelled while in progress (scheduled → missed/cancelled trips
-- never ran and keep NULL).
--
-- ended_at of an auto-closed trip is its last location fix (or its start), which can lie hours before
-- the close. Location ingestion uses closed_at to accept the offline queue recorded during the outage
-- that caused the auto-close, and to measure the 24-h late-points window (BP §10.3 rule 6).
alter table trips add column closed_at timestamptz;

update trips
   set closed_at = case when status = 'auto_closed' then greatest(ended_at, updated_at) else ended_at end
 where closed_at is null and started_at is not null and ended_at is not null
   and status in ('completed', 'auto_closed', 'cancelled');

alter table trips add constraint trips_closed_ck
  check (closed_at is null or (started_at is not null and closed_at >= started_at));
