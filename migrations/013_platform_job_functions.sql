-- 013 · Platform, worker and partition SECURITY DEFINER functions (BP §4.4, §6.3, §7.3;
-- contract §4, §8). Platform functions return counts or a school's admin accounts only — never
-- operational rows (Super Admin must not manage school data).

create or replace function assert_actor_role(p_allowed text[]) returns void
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  if not (coalesce(current_setting('app.actor_role', true), '') = any (p_allowed)) then
    raise exception 'Not allowed for this role' using errcode = '42501';
  end if;
end
$$;

-- Worker: schools whose jobs run (active, not deleted). Each school is then processed in its own
-- withTenant / withSchoolSystem transaction.
create or replace function active_school_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select s.id from schools s where s.status = 'active' and s.deleted_at is null order by s.id
$$;

create or replace function school_timezones()
returns table (school_id uuid, timezone text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select s.id, s.timezone from schools s where s.status = 'active' and s.deleted_at is null order by s.id
$$;

-- Super Admin dashboard: aggregate counts only (BP §4.4, §13.2).
create or replace function platform_health_counts()
returns table (schools_total bigint, schools_active bigint, schools_suspended bigint, schools_inactive bigint,
               buses_total bigint, active_trips bigint, trips_last_24h bigint, students_total bigint,
               parents_total bigint, staff_total bigint)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_actor_role(array['super_admin', 'system']);
  return query
  select (select count(*) from schools where deleted_at is null),
         (select count(*) from schools where deleted_at is null and status = 'active'),
         (select count(*) from schools where deleted_at is null and status = 'suspended'),
         (select count(*) from schools where deleted_at is null and status = 'inactive'),
         (select count(*) from buses where deleted_at is null),
         (select count(*) from trips where status = 'in_progress'),
         (select count(*) from trips where started_at > now() - interval '24 hours'),
         (select count(*) from students where deleted_at is null and is_active),
         (select count(*) from parent_accounts where is_active),
         (select count(*) from staff_profiles where deleted_at is null and is_active);
end
$$;

-- Super Admin school detail: usage summary of one school (counts only).
create or replace function school_usage_counts(p_school_id uuid)
returns table (buses bigint, students bigint, staff bigint, parents bigint, routes bigint, active_trips bigint,
               trips_last_30_days bigint, last_activity_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_actor_role(array['super_admin', 'system']);
  return query
  select (select count(*) from buses where school_id = p_school_id and deleted_at is null),
         (select count(*) from students where school_id = p_school_id and deleted_at is null and is_active),
         (select count(*) from staff_profiles where school_id = p_school_id and deleted_at is null and is_active),
         (select count(*) from school_parents where school_id = p_school_id and deleted_at is null and is_active),
         (select count(*) from routes where school_id = p_school_id and deleted_at is null),
         (select count(*) from trips where school_id = p_school_id and status = 'in_progress'),
         (select count(*) from trips where school_id = p_school_id and started_at > now() - interval '30 days'),
         (select max(greatest(t.last_point_at, t.started_at, t.ended_at)) from trips t where t.school_id = p_school_id);
end
$$;

-- Super Admin may create a school's admins and reset their access (BP §2.2) — nothing else.
create or replace function platform_school_admins(p_school_id uuid)
returns table (id uuid, full_name text, email citext, phone text, is_active boolean, must_change_password boolean,
               last_login_at timestamptz, created_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_actor_role(array['super_admin']);
  return query
  select u.id, u.full_name, u.email, u.phone, u.is_active, u.must_change_password, u.last_login_at, u.created_at
  from users u
  where u.school_id = p_school_id and u.role = 'school_admin' and u.deleted_at is null
  order by u.created_at;
end
$$;

create or replace function platform_create_school_admin(p_school_id uuid, p_full_name text, p_email citext,
                                                         p_password_hash text, p_phone text default null)
returns uuid
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform assert_actor_role(array['super_admin']);
  if not exists (select 1 from schools s where s.id = p_school_id and s.deleted_at is null) then
    raise exception 'School not found' using errcode = 'P0002';
  end if;
  insert into users (school_id, role, full_name, email, phone, password_hash, must_change_password, created_by)
  values (p_school_id, 'school_admin', btrim(p_full_name), p_email, p_phone, p_password_hash, true,
          nullif(current_setting('app.actor_id', true), '')::uuid)
  returning users.id into v_id;
  return v_id;
end
$$;

-- Sets a temporary password, forces a change at next login, clears lockout and revokes sessions.
create or replace function platform_reset_school_admin_password(p_school_id uuid, p_user_id uuid, p_password_hash text)
returns boolean
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_actor_role(array['super_admin']);
  update users u
     set password_hash = p_password_hash, must_change_password = true, failed_login_count = 0,
         locked_until = null, password_changed_at = null
   where u.id = p_user_id and u.school_id = p_school_id and u.role = 'school_admin' and u.deleted_at is null;
  if not found then
    return false;
  end if;
  update sessions s set revoked_at = now(), revoked_reason = 'password_reset'
   where s.owner_type = 'user' and s.owner_id = p_user_id and s.revoked_at is null;
  return true;
end
$$;

-- School deactivation / suspension revokes every session of the school (BP App. C).
create or replace function platform_revoke_school_sessions(p_school_id uuid, p_reason text default 'school_deactivated')
returns integer
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  perform assert_actor_role(array['super_admin', 'system']);
  update sessions s set revoked_at = now(), revoked_reason = p_reason
   where s.school_id = p_school_id and s.revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- session-cleanup job: expired/revoked sessions, used OTPs, expired idempotency records.
create or replace function session_cleanup(p_retention interval default interval '30 days')
returns table (sessions_deleted integer, otps_deleted integer, idempotency_deleted integer)
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_s integer; v_o integer; v_i integer;
begin
  perform assert_actor_role(array['system']);
  delete from sessions s where s.expires_at < now() - p_retention or s.revoked_at < now() - p_retention;
  get diagnostics v_s = row_count;
  delete from otp_codes o where o.expires_at < now() - interval '1 day';
  get diagnostics v_o = row_count;
  delete from idempotency_keys k where k.expires_at < now();
  get diagnostics v_i = row_count;
  return query select v_s, v_o, v_i;
end
$$;

-- partition-maintenance: monthly location_points partitions (UTC month boundaries). Each new
-- partition gets tenant RLS + FORCE and is hidden from parents when queried directly (reads go
-- through the parent table and its policies). Idempotent; returns the partitions it created.
create or replace function create_location_partitions(p_from date default current_date, p_months integer default 3)
returns setof text
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_start date;
  v_name text;
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
    execute format('create table public.%I partition of location_points for values from (%L) to (%L)',
                   v_name, to_char(v_start, 'YYYY-MM-DD') || ' 00:00:00+00',
                   to_char((v_start + interval '1 month')::date, 'YYYY-MM-DD') || ' 00:00:00+00');
    perform apply_tenant_rls(format('public.%I', v_name)::regclass);
    perform apply_parent_scope(format('public.%I', v_name)::regclass, 'false');
    return next v_name;
  end loop;
end
$$;

-- Drops monthly partitions that end on or before p_before (retention). Never the current month.
create or replace function drop_location_partitions(p_before date)
returns setof text
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_month date;
begin
  perform assert_actor_role(array['', 'system']);
  if p_before > date_trunc('month', now() at time zone 'UTC')::date then
    raise exception 'drop_location_partitions: refusing to drop the current month' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('wimb:location_partitions', 0));
  for r in
    select c.relname::text as name
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.location_points'::regclass and c.relname ~ '^location_points_[0-9]{4}_[0-9]{2}$'
    order by c.relname
  loop
    v_month := to_date(substring(r.name from '([0-9]{4}_[0-9]{2})$'), 'YYYY_MM');
    if (v_month + interval '1 month')::date <= p_before then
      execute format('drop table public.%I', r.name);
      return next r.name;
    end if;
  end loop;
end
$$;

-- Initial partitions: current month and the next two.
select create_location_partitions(current_date, 3);

revoke all on function assert_actor_role(text[]) from public;
revoke all on function active_school_ids() from public;
revoke all on function school_timezones() from public;
revoke all on function platform_health_counts() from public;
revoke all on function school_usage_counts(uuid) from public;
revoke all on function platform_school_admins(uuid) from public;
revoke all on function platform_create_school_admin(uuid, text, citext, text, text) from public;
revoke all on function platform_reset_school_admin_password(uuid, uuid, text) from public;
revoke all on function platform_revoke_school_sessions(uuid, text) from public;
revoke all on function session_cleanup(interval) from public;
revoke all on function create_location_partitions(date, integer) from public;
revoke all on function drop_location_partitions(date) from public;
revoke all on function app_local_date() from public;
