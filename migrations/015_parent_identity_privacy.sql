-- Parent identity privacy and race safety (contract §4: parent_accounts is a GLOBAL identity that
-- schools may only READ).
--   1. Column privacy: db:setup-roles grants the app role SELECT on the non-sensitive columns of
--      parent_accounts only (id, phone, display_name, preferred_language, is_active, created_at,
--      updated_at) — never password_hash, failed_login_count, locked_until or the global
--      last_login_at. Column privileges apply to every context of the app role (they are not RLS),
--      so every flow that needs a sensitive column runs through one of the SECURITY DEFINER
--      functions below, each scoped to the caller's own row or to the parents of the caller's school
--      and returning the minimum (flags instead of hashes/timestamps wherever possible).
--   2. Race safety: ensure_parent_account() and school_update_parent_phone() serialise on the same
--      transaction-level advisory lock per phone number. Two schools linking / correcting the same
--      parent can no longer interleave (school A's "linked here only" check vs school B's new link).
--      The lock is held until the caller's transaction ends, so the school_parents row the caller
--      inserts right after ensure_parent_account() is committed before the other school's check.

create or replace function parent_phone_lock(p_phone text) returns void
language sql volatile
set search_path = public, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('wimb:parent_phone:' || btrim(p_phone), 0));
$$;

-- ───────────── 1. registration and phone corrections (advisory lock per phone) ─────────────
create or replace function ensure_parent_account(p_phone text, p_display_name text default null)
returns uuid
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_phone text := btrim(p_phone);
begin
  if coalesce(current_setting('app.actor_role', true), '') not in ('school_admin', 'system')
     or nullif(current_setting('app.school_id', true), '') is null then
    raise exception 'ensure_parent_account: school admin context required' using errcode = '42501';
  end if;
  perform parent_phone_lock(v_phone);
  insert into parent_accounts (phone, display_name) values (v_phone, nullif(btrim(p_display_name), ''))
  on conflict (phone) do nothing
  returning id into v_id;
  if v_id is null then
    select pa.id into v_id from parent_accounts pa where pa.phone = v_phone;
  end if;
  return v_id;
end
$$;

create or replace function school_update_parent_phone(p_parent_id uuid, p_phone text)
returns uuid
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_school uuid := nullif(current_setting('app.school_id', true), '')::uuid;
  v_old text;
  v_new text := btrim(p_phone);
  v_now text;
begin
  if coalesce(current_setting('app.actor_role', true), '') not in ('school_admin', 'system') or v_school is null then
    raise exception 'school_update_parent_phone: school admin context required' using errcode = '42501';
  end if;
  select pa.phone into v_old from parent_accounts pa where pa.id = p_parent_id;
  if not found then
    raise exception 'school_update_parent_phone: parent not found' using errcode = 'P0002';
  end if;
  -- Both numbers, in a fixed order (no deadlock between two corrections that swap numbers).
  perform parent_phone_lock(least(v_old, v_new));
  if v_old <> v_new then perform parent_phone_lock(greatest(v_old, v_new)); end if;
  select pa.phone into v_now from parent_accounts pa where pa.id = p_parent_id for update;
  if v_now is distinct from v_old then
    raise exception 'school_update_parent_phone: the parent changed in the meantime' using errcode = '40001';
  end if;
  if not exists (select 1 from school_parents sp
                 where sp.parent_account_id = p_parent_id and sp.school_id = v_school and sp.deleted_at is null) then
    raise exception 'school_update_parent_phone: parent not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from school_parents sp
             where sp.parent_account_id = p_parent_id and sp.school_id <> v_school and sp.deleted_at is null) then
    raise exception 'school_update_parent_phone: the parent account is shared with another school' using errcode = 'P0001';
  end if;
  update parent_accounts set phone = v_new, updated_at = now() where id = p_parent_id;
  return p_parent_id;
end
$$;

-- ───────────── 2. the parent's own sensitive columns ─────────────
-- Password hash of the CALLING parent (change-password verification, "has password" flag).
create or replace function parent_self_password_hash()
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select pa.password_hash from parent_accounts pa
   where current_setting('app.actor_role', true) = 'parent'
     and pa.id = nullif(current_setting('app.actor_id', true), '')::uuid
$$;

-- Failed parent sign-in (auth lockout mirror, same rules as auth repository recordLoginFailure):
-- p_count = position in the KV window (null → increment the row counter), p_lock = this failure
-- locks. Caller: the parent's own pre-authentication context (actor_role parent, actor_id = id) or
-- system. → locked_until (null when not locked).
create or replace function parent_record_login_failure(p_parent_id uuid, p_count integer, p_lock boolean, p_max integer, p_lock_minutes integer)
returns timestamptz
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_until timestamptz;
begin
  if not (coalesce(current_setting('app.actor_role', true), '') = 'system'
          or (current_setting('app.actor_role', true) = 'parent'
              and nullif(current_setting('app.actor_id', true), '')::uuid = p_parent_id)) then
    raise exception 'parent_record_login_failure: own context required' using errcode = '42501';
  end if;
  if p_max < 1 or p_lock_minutes < 1 then
    raise exception 'parent_record_login_failure: invalid policy' using errcode = '22023';
  end if;
  with v as (
    select case when p_count is not null then p_count
                when t.locked_until is not null and t.locked_until <= now() then 1
                else t.failed_login_count + 1 end as n
      from parent_accounts t where t.id = p_parent_id
  )
  update parent_accounts t
     set failed_login_count = case when p_lock or v.n >= p_max then 0 else v.n end,
         locked_until = case when p_lock or v.n >= p_max then now() + make_interval(mins => p_lock_minutes)
                             when t.locked_until is not null and t.locked_until <= now() then null
                             else t.locked_until end
    from v
   where t.id = p_parent_id
  returning t.locked_until into v_until;
  return v_until;
end
$$;

-- ───────────── 3. what a school may know about its parents' accounts ─────────────
-- Flags only (never timestamps or counters) for the parents linked to the caller's school.
create or replace function school_parent_sign_in_state()
returns table (parent_account_id uuid, has_signed_in boolean, is_locked boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select pa.id, pa.last_login_at is not null, coalesce(pa.locked_until > now(), false)
    from parent_accounts pa
   where coalesce(current_setting('app.actor_role', true), '') in ('school_admin', 'system')
     and exists (select 1 from school_parents sp
                  where sp.parent_account_id = pa.id
                    and sp.school_id = nullif(current_setting('app.school_id', true), '')::uuid
                    and sp.deleted_at is null)
$$;

-- Clears a failed-sign-in lock of a parent linked to the caller's school (reset-access).
-- → true when a lock or failure counter was cleared. P0002 when the parent is not linked here.
create or replace function school_clear_parent_lockout(p_parent_id uuid)
returns boolean
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_school uuid := nullif(current_setting('app.school_id', true), '')::uuid;
begin
  if coalesce(current_setting('app.actor_role', true), '') not in ('school_admin', 'system') or v_school is null then
    raise exception 'school_clear_parent_lockout: school admin context required' using errcode = '42501';
  end if;
  if not exists (select 1 from school_parents sp
                 where sp.parent_account_id = p_parent_id and sp.school_id = v_school and sp.deleted_at is null) then
    raise exception 'school_clear_parent_lockout: parent not found' using errcode = 'P0002';
  end if;
  update parent_accounts set failed_login_count = 0, locked_until = null, updated_at = now()
   where id = p_parent_id and (failed_login_count > 0 or locked_until is not null);
  return found;
end
$$;

revoke all on function parent_phone_lock(text) from public;
revoke all on function ensure_parent_account(text, text) from public;
revoke all on function school_update_parent_phone(uuid, text) from public;
revoke all on function parent_self_password_hash() from public;
revoke all on function parent_record_login_failure(uuid, integer, boolean, integer, integer) from public;
revoke all on function school_parent_sign_in_state() from public;
revoke all on function school_clear_parent_lockout(uuid) from public;
