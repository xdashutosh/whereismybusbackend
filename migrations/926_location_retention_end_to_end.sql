-- Tracking / jobs (lane B range 925–949): per-school location retention honoured end to end
-- (BP §6.3, §9.6 "keep raw points for N months … afterwards downsample to a simplified polyline stored in
-- trips.summary and drop old partitions", §12 privacy; migration 800 introduced the school override).
--
-- location_retention_cutoffs()  one row per school: its EFFECTIVE retention in months =
--     least(platform location.retention_months, school_settings.location_retention_months) — the platform
--     value is the maximum, a larger (stale) override counts as the platform value — and the cutoff
--     instant: first day of (current UTC month − months), 00:00 UTC (the month-boundary rule of the
--     partitions). The partition-maintenance job reads it to downsample the trips that are about to lose
--     their raw points (simplified path kept in trips.summary) BEFORE it purges them.
-- location_partition_maintenance()  as in migration 800, plus: the coordinates of trip_device_events
--     (migration 925) older than the school's cutoff are cleared (the event itself stays in the trip
--     timeline, like alerts). New output column device_event_coords_purged.
-- Both are SECURITY DEFINER for the 'system' actor (partition-maintenance job). Idempotent.

create index if not exists trip_device_events_school_time_idx on trip_device_events (school_id, occurred_at);

create or replace function location_retention_cutoffs()
returns table (school_id uuid, retention_months integer, cutoff timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_month date := date_trunc('month', (now() at time zone 'UTC'))::date;
  v_platform integer;
begin
  perform assert_actor_role(array['', 'system']);
  select case when jsonb_typeof(ps.value) = 'number' then least(greatest((ps.value #>> '{}')::numeric::integer, 1), 120) end
    into v_platform
    from platform_settings ps where ps.key = 'location.retention_months';
  v_platform := coalesce(v_platform, 12);
  return query
    select s.id,
           least(v_platform, coalesce(ss.location_retention_months, v_platform))::integer,
           ((v_month - make_interval(months => least(v_platform, coalesce(ss.location_retention_months, v_platform))))::date)::timestamp at time zone 'UTC'
      from schools s
      left join school_settings ss on ss.school_id = s.id
     order by s.id;
end
$$;

revoke all on function location_retention_cutoffs() from public;

-- The result type changes (new OUT column) → drop and recreate.
drop function if exists location_partition_maintenance(integer);

create function location_partition_maintenance(p_months_ahead integer default 3)
returns table (created text[], dropped text[], default_rows bigint, retention_months integer, school_rows_purged bigint, device_event_coords_purged bigint)
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'UTC')::date;
  v_month date := date_trunc('month', (now() at time zone 'UTC'))::date;
  v_retention integer;
  v_cutoff date;
  v_school record;
  v_school_cutoff date;
  v_n bigint;
begin
  perform assert_actor_role(array['', 'system']);
  select case when jsonb_typeof(ps.value) = 'number' then least(greatest((ps.value #>> '{}')::numeric::integer, 1), 120) end
    into v_retention
    from platform_settings ps where ps.key = 'location.retention_months';
  v_retention := coalesce(v_retention, 12);
  v_cutoff := (v_month - make_interval(months => v_retention))::date;
  created := array(select create_location_partitions(v_today, p_months_ahead));
  dropped := array(select drop_location_partitions(v_cutoff));
  delete from location_points_default d where d.recorded_at < v_cutoff::timestamp at time zone 'UTC';

  -- Per-school overrides shorter than the platform retention.
  school_rows_purged := 0;
  for v_school in
    select ss.school_id, ss.location_retention_months as months
      from school_settings ss
     where ss.location_retention_months is not null and ss.location_retention_months < v_retention
  loop
    v_school_cutoff := (v_month - make_interval(months => v_school.months))::date;
    -- Trips of a school-local date up to the cutoff can hold points before it (any time zone);
    -- older trips lost their points with the platform partitions (3 days of slack for long trips).
    delete from location_points lp
     using trips t
     where t.school_id = v_school.school_id
       and t.trip_date between v_cutoff - 3 and v_school_cutoff
       and lp.trip_id = t.id
       and lp.school_id = v_school.school_id
       and lp.recorded_at < v_school_cutoff::timestamp at time zone 'UTC';
    get diagnostics v_n = row_count;
    school_rows_purged := school_rows_purged + v_n;
  end loop;

  -- Coordinates reported with device events: same effective cutoff per school (platform or shorter).
  update trip_device_events e
     set latitude = null, longitude = null
    from location_retention_cutoffs() c
   where e.school_id = c.school_id
     and (e.latitude is not null or e.longitude is not null)
     and e.occurred_at < c.cutoff;
  get diagnostics v_n = row_count;
  device_event_coords_purged := v_n;

  select count(*) into default_rows from location_points_default;
  retention_months := v_retention;
  return next;
end
$$;

revoke all on function location_partition_maintenance(integer) from public;
