-- Jobs (lane B range 850–899): durable cursor of the school-cron dispatcher.
--
-- The every-minute dispatcher (src/jobs/schoolCron.ts) covers the window (last dispatched minute, now]
-- so late or skipped ticks never drop a school-local run (generate-daily-trips at 00:05 local, the
-- morning scans, the alert digest). The cursor used to live only in the KV store, which is process
-- memory when REDIS_URL is empty (the Render deployment): a deploy or crash restart between 00:04 and
-- 00:11 school-local skipped that day's trip generation. Kept here, it survives restarts; every
-- instance reads and writes the same row. A platform table: no school_id, RLS forced, readable and
-- writable only by the 'system' actor (background jobs). Grants: db:setup-roles.
create table job_dispatch_state (
  cursor_key  text primary key check (length(cursor_key) between 1 and 100),
  last_minute timestamptz not null,
  updated_at  timestamptz not null default now()
);

select apply_platform_rls('job_dispatch_state');
create policy job_dispatch_state_system on job_dispatch_state for all
  using (current_setting('app.actor_role', true) = 'system')
  with check (current_setting('app.actor_role', true) = 'system');
