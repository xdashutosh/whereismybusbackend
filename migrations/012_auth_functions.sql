-- 012 · Pre-authentication and session SECURITY DEFINER functions (BP §4.5, §5; contract §4, §6).
-- Owned by the owner role, fixed search_path, minimal columns, no general bypass. EXECUTE is
-- revoked from PUBLIC here and granted to the app role by db:setup-roles. They run as the owner
-- and reach rows through the definer_access policies (FORCE RLS applies to the owner too).

-- Session + actor for authenticate() / socket handshake (src/shared/sessions.ts). Never cached.
create or replace function auth_session_actor(p_session_id uuid)
returns table (session_id uuid, owner_type text, owner_id uuid, school_id uuid, device_id uuid,
               revoked_at timestamptz, expires_at timestamptz, actor_active boolean, actor_role text,
               actor_name text, must_change_password boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select s.id, s.owner_type, s.owner_id, s.school_id, s.device_id, s.revoked_at, s.expires_at,
         case s.owner_type
           when 'platform_user' then coalesce(pu.is_active, false)
           when 'user' then coalesce(u.is_active and u.deleted_at is null, false)
           else coalesce(pa.is_active, false)
         end,
         case s.owner_type
           when 'platform_user' then case when pu.id is not null then 'super_admin' end
           when 'user' then u.role
           else case when pa.id is not null then 'parent' end
         end,
         case s.owner_type
           when 'platform_user' then pu.name
           when 'user' then u.full_name
           else coalesce(pa.display_name,
                         (select sp.full_name from school_parents sp
                          where sp.parent_account_id = pa.id and sp.deleted_at is null
                          order by sp.created_at limit 1))
         end,
         case s.owner_type
           when 'platform_user' then coalesce(pu.must_change_password, false)
           when 'user' then coalesce(u.must_change_password, false)
           else false
         end
  from sessions s
  left join platform_users pu on s.owner_type = 'platform_user' and pu.id = s.owner_id
  left join users u on s.owner_type = 'user' and u.id = s.owner_id and u.school_id = s.school_id
  left join parent_accounts pa on s.owner_type = 'parent_account' and pa.id = s.owner_id
  where s.id = p_session_id
$$;

-- Refresh-token lookup (rotation + reuse detection happen in the auth module, in the owner's context).
create or replace function auth_session_by_refresh(p_refresh_hash text)
returns table (session_id uuid, family_id uuid, owner_type text, owner_id uuid, school_id uuid, device_id uuid,
               client text, expires_at timestamptz, rotated_at timestamptz, revoked_at timestamptz)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select s.id, s.family_id, s.owner_type, s.owner_id, s.school_id, s.device_id, s.client, s.expires_at, s.rotated_at, s.revoked_at
  from sessions s
  where s.refresh_hash = p_refresh_hash
$$;

-- Login lookups, one per login type (contract §6).
create or replace function auth_platform_login(p_email citext)
returns table (id uuid, name text, password_hash text, must_change_password boolean, totp_enabled boolean,
               totp_secret_enc text, totp_last_used_step bigint, is_active boolean, failed_login_count integer,
               locked_until timestamptz)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.id, p.name, p.password_hash, p.must_change_password, p.totp_enabled, p.totp_secret_enc,
         p.totp_last_used_step, p.is_active, p.failed_login_count, p.locked_until
  from platform_users p
  where p.email = p_email
$$;

create or replace function auth_school_admin_login(p_email citext)
returns table (id uuid, school_id uuid, school_status text, school_deleted boolean, full_name text, password_hash text,
               must_change_password boolean, is_active boolean, failed_login_count integer, locked_until timestamptz)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select u.id, u.school_id, s.status, s.deleted_at is not null, u.full_name, u.password_hash,
         u.must_change_password, u.is_active, u.failed_login_count, u.locked_until
  from users u
  join schools s on s.id = u.school_id
  where u.email = p_email and u.role = 'school_admin' and u.deleted_at is null
$$;

-- Staff: school code + phone (E.164) or username.
create or replace function auth_staff_login(p_school_code text, p_identifier text)
returns table (id uuid, school_id uuid, school_status text, school_deleted boolean, role text, full_name text,
               password_hash text, pin_hash text, must_change_password boolean, is_active boolean,
               failed_login_count integer, locked_until timestamptz)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select u.id, u.school_id, s.status, s.deleted_at is not null, u.role, u.full_name, u.password_hash, u.pin_hash,
         u.must_change_password, u.is_active, u.failed_login_count, u.locked_until
  from schools s
  join users u on u.school_id = s.id
  where s.code = upper(btrim(p_school_code))
    and u.role in ('driver', 'conductor')
    and u.deleted_at is null
    and (u.phone = btrim(p_identifier) or u.username = btrim(p_identifier)::citext)
  limit 1
$$;

-- Parent: phone (E.164). has_active_link = registered by at least one active school.
create or replace function auth_parent_login(p_phone text)
returns table (id uuid, password_hash text, is_active boolean, failed_login_count integer, locked_until timestamptz,
               has_active_link boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select pa.id, pa.password_hash, pa.is_active, pa.failed_login_count, pa.locked_until,
         exists (select 1 from school_parents sp
                 join schools s on s.id = sp.school_id
                 where sp.parent_account_id = pa.id and sp.is_active and sp.deleted_at is null
                   and s.status = 'active' and s.deleted_at is null)
  from parent_accounts pa
  where pa.phone = btrim(p_phone)
$$;

-- OTP issue: atomic per phone + purpose (xact advisory lock → PgBouncer-safe). Stores only the
-- hash. Returns 'issued' or 'cooldown' (with the seconds left before a resend is allowed).
create or replace function otp_request(p_phone text, p_purpose text, p_code_hash text, p_ttl_seconds integer,
                                       p_cooldown_seconds integer, p_max_attempts integer, p_ip inet default null)
returns table (status text, retry_after_s integer, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v otp_codes%rowtype;
  v_expires timestamptz;
begin
  if p_ttl_seconds not between 30 and 3600 or p_cooldown_seconds not between 0 and 3600 or p_max_attempts not between 1 and 10
     or coalesce(length(p_code_hash), 0) < 16 then
    raise exception 'otp_request: invalid arguments' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('otp:' || p_phone || ':' || p_purpose, 0));
  select * into v from otp_codes o where o.phone = p_phone and o.purpose = p_purpose;
  if found and v.consumed_at is null and v.expires_at > now()
     and v.last_sent_at > now() - make_interval(secs => p_cooldown_seconds) then
    return query select 'cooldown'::text,
      greatest(1, ceil(extract(epoch from (v.last_sent_at + make_interval(secs => p_cooldown_seconds) - now())))::integer),
      v.expires_at;
    return;
  end if;
  insert into otp_codes as o (phone, purpose, code_hash, expires_at, attempts, max_attempts, consumed_at, last_sent_at, send_count, request_ip)
  values (p_phone, p_purpose, p_code_hash, now() + make_interval(secs => p_ttl_seconds), 0, p_max_attempts, null, now(), 1, p_ip)
  on conflict (phone, purpose) do update
     set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
         max_attempts = excluded.max_attempts, consumed_at = null, last_sent_at = now(),
         send_count = case when o.consumed_at is null then o.send_count + 1 else 1 end,
         request_ip = excluded.request_ip
  returning o.expires_at into v_expires;
  return query select 'issued'::text, 0, v_expires;
end
$$;

-- OTP verify: 'ok' (consumed) | 'invalid' | 'locked' (attempts exhausted) | 'expired' | 'not_found'.
create or replace function otp_verify(p_phone text, p_purpose text, p_code_hash text)
returns table (status text, attempts_left integer)
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v otp_codes%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('otp:' || p_phone || ':' || p_purpose, 0));
  select * into v from otp_codes o where o.phone = p_phone and o.purpose = p_purpose;
  if not found or v.consumed_at is not null then
    return query select 'not_found'::text, 0; return;
  end if;
  if v.expires_at <= now() then
    return query select 'expired'::text, 0; return;
  end if;
  if v.attempts >= v.max_attempts then
    return query select 'locked'::text, 0; return;
  end if;
  if v.code_hash = p_code_hash then
    update otp_codes o set attempts = o.attempts + 1, consumed_at = now() where o.id = v.id;
    return query select 'ok'::text, greatest(v.max_attempts - v.attempts - 1, 0); return;
  end if;
  update otp_codes o set attempts = o.attempts + 1 where o.id = v.id;
  return query select case when v.attempts + 1 >= v.max_attempts then 'locked' else 'invalid' end::text,
                      greatest(v.max_attempts - v.attempts - 1, 0);
end
$$;

-- (school_id, student_id) pairs of a parent's ACTIVE links (resolveTenant, GET /parent/children).
-- School status is checked by resolveTenant (suspended → SCHOOL_INACTIVE, not "not linked").
create or replace function parent_children_index(p_parent_id uuid)
returns table (school_id uuid, student_id uuid)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select l.school_id, l.student_id
  from student_parents l
  join parent_accounts pa on pa.id = l.parent_account_id and pa.is_active
  join school_parents p on p.school_id = l.school_id and p.parent_account_id = l.parent_account_id
                       and p.is_active and p.deleted_at is null
  join students s on s.id = l.student_id and s.school_id = l.school_id and s.is_active and s.deleted_at is null
  join schools sc on sc.id = l.school_id and sc.deleted_at is null
  where l.parent_account_id = p_parent_id
$$;

-- School admins register parents by phone: returns the global identity (creating it when new)
-- without revealing anything else about it. Caller: school_admin / system in a school context.
create or replace function ensure_parent_account(p_phone text, p_display_name text default null)
returns uuid
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if coalesce(current_setting('app.actor_role', true), '') not in ('school_admin', 'system')
     or nullif(current_setting('app.school_id', true), '') is null then
    raise exception 'ensure_parent_account: school admin context required' using errcode = '42501';
  end if;
  insert into parent_accounts (phone, display_name) values (btrim(p_phone), nullif(btrim(p_display_name), ''))
  on conflict (phone) do nothing
  returning id into v_id;
  if v_id is null then
    select pa.id into v_id from parent_accounts pa where pa.phone = btrim(p_phone);
  end if;
  return v_id;
end
$$;

-- Parent inbox: marks the caller's own notifications as read in every school (the inbox spans
-- schools; RLS lets parents read but not write them outside a school context). NULL = all unread.
create or replace function parent_notifications_mark_read(p_ids uuid[] default null)
returns integer
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_parent uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_count integer;
begin
  if coalesce(current_setting('app.actor_role', true), '') <> 'parent' or v_parent is null then
    raise exception 'parent_notifications_mark_read: parent context required' using errcode = '42501';
  end if;
  update parent_notifications n set read_at = now()
   where n.parent_account_id = v_parent and n.read_at is null and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function parent_notifications_mark_read(uuid[]) from public;
revoke all on function auth_session_actor(uuid) from public;
revoke all on function auth_session_by_refresh(text) from public;
revoke all on function auth_platform_login(citext) from public;
revoke all on function auth_school_admin_login(citext) from public;
revoke all on function auth_staff_login(text, text) from public;
revoke all on function auth_parent_login(text) from public;
revoke all on function otp_request(text, text, text, integer, integer, integer, inet) from public;
revoke all on function otp_verify(text, text, text) from public;
revoke all on function parent_children_index(uuid) from public;
revoke all on function ensure_parent_account(text, text) from public;
