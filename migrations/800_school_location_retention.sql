-- 800 · Per-school location-history retention (BP §12 privacy; lane A range 800–849).
-- school_settings.location_retention_months (migration 003, 1–60, NULL = platform value) becomes a
-- real override: a school may keep its raw location points for FEWER months than the platform
-- setting location.retention_months, never more (the platform value is the maximum; a larger
-- override is refused by the API and capped here anyway).
--   * location.retention_months becomes a public platform setting so school admins can read the
--     maximum they may choose (it is an operational number, not a secret).
--   * location_partition_maintenance() (partition-maintenance job, daily) still drops whole month
--     partitions at the platform cutoff and now also deletes, per school with a shorter override,
--     that school's points older than the first day of (current UTC month − school months) — the same
--     month-boundary rule as the partitions. Points are found through the school's trips of the
--     affected dates (index on trips (school_id, trip_date) → location_points PK (trip_id, recorded_at)),
--     so no other school's rows are scanned. New output column school_rows_purged.
-- Replaced documents and uploaded files are NOT purged: they are kept for audit (product decision,
-- see backend/README.md "Retention").

-- platform_settings is FORCE RLS: the owner needs the system context (definer_access policy).
select set_config('app.actor_role', 'system', true);
update platform_settings set is_public = true where key = 'location.retention_months';

-- The result type changes (new OUT column) → drop and recreate.
drop function if exists location_partition_maintenance(integer);

create function location_partition_maintenance(p_months_ahead integer default 3)
returns table (created text[], dropped text[], default_rows bigint, retention_months integer, school_rows_purged bigint)
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

  select count(*) into default_rows from location_points_default;
  retention_months := v_retention;
  return next;
end
$$;

revoke all on function location_partition_maintenance(integer) from public;
