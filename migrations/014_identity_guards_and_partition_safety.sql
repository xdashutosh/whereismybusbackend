-- 014 · Verification fixes for the core schema (contract §3, §4, §8; BP §4.3, §6.3, §11.2).
--   1. parent_accounts is a GLOBAL identity shared by every school a parent belongs to:
--      · school admins can no longer UPDATE it through RLS (parent_accounts_school_update let any
--        school that linked a phone rewrite the parent's password/phone/active flag for all schools);
--        school-specific data lives in school_parents. A phone correction goes through
--        school_update_parent_phone(), allowed only while the parent belongs to the caller's school
--        alone.
--      · a column guard trigger: outside SECURITY DEFINER functions and owner sessions, an UPDATE
--        may only change display_name, preferred_language, password_hash and the sign-in counters
--        (failed_login_count, locked_until, last_login_at). A parent can no longer move its identity
--        to another phone number or reactivate itself.
--   2. Date defaults never depend on the session TimeZone: student_assignments.valid_from and
--      school_subscriptions.valid_from default to the row's SCHOOL-LOCAL date (trigger).
--   3. notification_events: trip-level events (student_id NULL) are deduplicated per (trip, event).
--   4. location_points never rejects a point for lack of a partition: a DEFAULT partition catches
--      rows outside the pre-created months, create_location_partitions moves such rows into the
--      month partition it creates, and location_partition_maintenance() (partition-maintenance job)
--      creates months ahead, drops expired months per location.retention_months, purges expired
--      default rows and reports how many rows sit in the default partition.

-- ───────────── 1. parent_accounts: global identity guards ─────────────
drop policy if exists parent_accounts_school_update on parent_accounts;

-- Columns an ordinary (non-definer, non-owner) UPDATE may change. Everything else — phone, is_active,
-- id, created_at and any column added later — needs a SECURITY DEFINER flow.
create or replace function parent_accounts_guard() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mutable constant text[] := array['display_name', 'preferred_language', 'password_hash',
                                     'failed_login_count', 'locked_until', 'last_login_at', 'updated_at'];
begin
  if current_user <> session_user
     or pg_has_role(current_user, (select c.relowner from pg_class c where c.oid = tg_relid), 'MEMBER') then
    return new;
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'parent_accounts: phone and account status can only change through a verified flow'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger parent_accounts_guard
  before update on parent_accounts
  for each row execute function parent_accounts_guard();

-- School admins correct a parent's phone number (typo, new SIM). Allowed only while the parent is
-- linked (non-deleted school_parents row) in the caller's school and in NO other school — a shared
-- identity is never changed by one school. Raises 42501 (role), P0002 (not this school's parent),
-- P0001 (linked in another school); a phone already in use raises 23505 (parent_accounts_phone_key).
create or replace function school_update_parent_phone(p_parent_id uuid, p_phone text)
returns uuid
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_school uuid := nullif(current_setting('app.school_id', true), '')::uuid;
begin
  if coalesce(current_setting('app.actor_role', true), '') not in ('school_admin', 'system') or v_school is null then
    raise exception 'school_update_parent_phone: school admin context required' using errcode = '42501';
  end if;
  perform 1 from parent_accounts pa where pa.id = p_parent_id for update;
  if not found or not exists (select 1 from school_parents sp
                              where sp.parent_account_id = p_parent_id and sp.school_id = v_school
                                and sp.deleted_at is null) then
    raise exception 'school_update_parent_phone: parent not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from school_parents sp
             where sp.parent_account_id = p_parent_id and sp.school_id <> v_school and sp.deleted_at is null) then
    raise exception 'school_update_parent_phone: the parent account is shared with another school' using errcode = 'P0001';
  end if;
  update parent_accounts set phone = btrim(p_phone), updated_at = now() where id = p_parent_id;
  return p_parent_id;
end
$$;

-- ───────────── 2. school-local date defaults ─────────────
-- Today's date in a school's timezone (Asia/Kolkata when unknown). Returns a date only.
create or replace function school_local_date(p_school_id uuid) returns date
language sql stable security definer
set search_path = public, pg_temp
as $$
  select (now() at time zone coalesce((select s.timezone from schools s where s.id = p_school_id), 'Asia/Kolkata'))::date
$$;

create or replace function fill_school_local_valid_from() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.valid_from is null then
    new.valid_from := school_local_date(new.school_id);
  end if;
  return new;
end
$$;

alter table student_assignments alter column valid_from drop default;
create trigger student_assignments_valid_from
  before insert on student_assignments
  for each row execute function fill_school_local_valid_from();

alter table school_subscriptions alter column valid_from drop default;
create trigger school_subscriptions_valid_from
  before insert on school_subscriptions
  for each row execute function fill_school_local_valid_from();

-- ───────────── 3. trip-level notification dedupe ─────────────
-- notification_events_dedupe treats NULL student_ids as distinct; trip-level events need their own.
create unique index notification_events_trip_dedupe on notification_events (trip_id, event_type) where student_id is null;

-- ───────────── 4. location_points partition safety ─────────────
create table location_points_default partition of location_points default;
select apply_tenant_rls('location_points_default');
select apply_parent_scope('location_points_default', 'false');

-- Same contract as 013, plus: rows that landed in the DEFAULT partition for a month being created
-- are moved into the new month partition (otherwise CREATE … PARTITION OF fails on them).
create or replace function create_location_partitions(p_from date default current_date, p_months integer default 3)
returns setof text
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_start date;
  v_lo timestamptz;
  v_hi timestamptz;
  v_name text;
  v_moved bigint;
begin
  perform assert_actor_role(array['', 'system']);
  if p_months not between 1 and 24 then
    raise exception 'create_location_partitions: p_months must be between 1 and 24' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('wimb:location_partitions', 0));
  for i in 0 .. p_months - 1 loop
    v_start := (date_trunc('month', p_from) + make_interval(months => i))::date;
    v_name := format('location_points_%s', to_char(v_start, 'YYYY_MM'));
    continue when to_regclass(format('public.%I', v_name)) is not null;
    v_lo := v_start::timestamp at time zone 'UTC';
    v_hi := (v_start + interval '1 month')::timestamp at time zone 'UTC';
    v_moved := 0;
    if exists (select 1 from location_points_default d where d.recorded_at >= v_lo and d.recorded_at < v_hi) then
      create temp table if not exists wimb_location_moved (like location_points) on commit drop;
      truncate wimb_location_moved;
      with moved as (
        delete from location_points_default d where d.recorded_at >= v_lo and d.recorded_at < v_hi returning d.*
      )
      insert into wimb_location_moved select * from moved;
      get diagnostics v_moved = row_count;
    end if;
    execute format('create table public.%I partition of location_points for values from (%L) to (%L)',
                   v_name, v_lo, v_hi);
    perform apply_tenant_rls(format('public.%I', v_name)::regclass);
    perform apply_parent_scope(format('public.%I', v_name)::regclass, 'false');
    if v_moved > 0 then
      insert into location_points select * from wimb_location_moved;
      truncate wimb_location_moved;
    end if;
    return next v_name;
  end loop;
end
$$;

-- partition-maintenance job (contract §8): one call does the whole pass inside the caller's
-- transaction. Retention comes from platform_settings 'location.retention_months' (default 12,
-- 1–120): month partitions ending on or before the first day of (current UTC month − retention) are
-- dropped and older rows in the DEFAULT partition purged. default_rows > 0 means points arrived
-- outside the pre-created months (the job raises an alert in the log).
create or replace function location_partition_maintenance(p_months_ahead integer default 3)
returns table (created text[], dropped text[], default_rows bigint, retention_months integer)
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'UTC')::date;
  v_retention integer;
  v_cutoff date;
begin
  perform assert_actor_role(array['', 'system']);
  select case when jsonb_typeof(ps.value) = 'number' then least(greatest((ps.value #>> '{}')::numeric::integer, 1), 120) end
    into v_retention
    from platform_settings ps where ps.key = 'location.retention_months';
  v_retention := coalesce(v_retention, 12);
  v_cutoff := (date_trunc('month', v_today) - make_interval(months => v_retention))::date;
  created := array(select create_location_partitions(v_today, p_months_ahead));
  dropped := array(select drop_location_partitions(v_cutoff));
  delete from location_points_default d where d.recorded_at < v_cutoff::timestamp at time zone 'UTC';
  select count(*) into default_rows from location_points_default;
  retention_months := v_retention;
  return next;
end
$$;

revoke all on function parent_accounts_guard() from public;
revoke all on function school_update_parent_phone(uuid, text) from public;
revoke all on function school_local_date(uuid) from public;
revoke all on function fill_school_local_valid_from() from public;
revoke all on function location_partition_maintenance(integer) from public;
