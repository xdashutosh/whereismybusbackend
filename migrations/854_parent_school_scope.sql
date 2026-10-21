-- Parent identity per school (lane B range 850–899; contract §4, BP §4.9 tenant isolation).
-- parent_accounts is global and any school may register any mobile number (ensure_parent_account),
-- so a school must never act on — or learn about — what the parent does in ANOTHER school:
--   * school_parents.first_signed_in_at: when the parent first used THIS school (its children list
--     or a per-child request with this school's X-School-Id). It replaces the global last_login_at
--     as the "has signed in" flag a school sees (no enumeration oracle by registering a number).
--   * A school may end the parent's (global) sessions or clear its (global) sign-in lock only when
--     the parent does not use another school: school_parent_used_elsewhere(). Otherwise its own
--     deactivation/deletion still blocks the parent there (resolveTenant re-checks every request).
alter table school_parents add column if not exists first_signed_in_at timestamptz;

-- Existing data: a parent who has signed in and has a child link in a school counts as having used it.
update school_parents sp
   set first_signed_in_at = pa.last_login_at
  from parent_accounts pa
 where pa.id = sp.parent_account_id
   and pa.last_login_at is not null
   and sp.first_signed_in_at is null
   and exists (select 1 from student_parents l where l.school_id = sp.school_id and l.parent_account_id = sp.parent_account_id);

-- The CALLING parent marks the school of its context as used (only with an active child link there).
-- → true when this call set the timestamp.
create or replace function parent_mark_school_used()
returns boolean
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_school uuid := nullif(current_setting('app.school_id', true), '')::uuid;
  v_parent uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
begin
  if coalesce(current_setting('app.actor_role', true), '') <> 'parent' or v_school is null or v_parent is null then
    raise exception 'parent_mark_school_used: parent context required' using errcode = '42501';
  end if;
  update school_parents sp set first_signed_in_at = now()
   where sp.school_id = v_school and sp.parent_account_id = v_parent
     and sp.deleted_at is null and sp.first_signed_in_at is null
     and exists (select 1 from parent_children_index(v_parent) ix where ix.school_id = v_school);
  return found;
end
$$;

-- Whether a parent linked to the caller's school uses ANOTHER school (a live school_parents row
-- there with first_signed_in_at). P0002 when the parent is not linked here.
create or replace function school_parent_used_elsewhere(p_parent_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_school uuid := nullif(current_setting('app.school_id', true), '')::uuid;
begin
  if coalesce(current_setting('app.actor_role', true), '') not in ('school_admin', 'system') or v_school is null then
    raise exception 'school_parent_used_elsewhere: school admin context required' using errcode = '42501';
  end if;
  if not exists (select 1 from school_parents sp
                 where sp.parent_account_id = p_parent_id and sp.school_id = v_school and sp.deleted_at is null) then
    raise exception 'school_parent_used_elsewhere: parent not found' using errcode = 'P0002';
  end if;
  return exists (select 1 from school_parents sp
                  where sp.parent_account_id = p_parent_id and sp.school_id <> v_school
                    and sp.deleted_at is null and sp.first_signed_in_at is not null);
end
$$;

-- Flags only, per school: has_signed_in = the parent used THIS school; is_locked only when the
-- parent uses no other school (a lock earned elsewhere is none of this school's business).
create or replace function school_parent_sign_in_state()
returns table (parent_account_id uuid, has_signed_in boolean, is_locked boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select pa.id,
         sp.first_signed_in_at is not null,
         coalesce(pa.locked_until > now(), false)
           and not exists (select 1 from school_parents o
                            where o.parent_account_id = pa.id and o.school_id <> sp.school_id
                              and o.deleted_at is null and o.first_signed_in_at is not null)
    from school_parents sp
    join parent_accounts pa on pa.id = sp.parent_account_id
   where coalesce(current_setting('app.actor_role', true), '') in ('school_admin', 'system')
     and sp.school_id = nullif(current_setting('app.school_id', true), '')::uuid
     and sp.deleted_at is null
$$;

-- Clears a failed-sign-in lock of a parent linked to the caller's school (reset-access), but never
-- the lock of a parent who uses another school (P0001). → true when a lock or counter was cleared.
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
  if exists (select 1 from school_parents sp
             where sp.parent_account_id = p_parent_id and sp.school_id <> v_school
               and sp.deleted_at is null and sp.first_signed_in_at is not null) then
    raise exception 'school_clear_parent_lockout: the parent account is used by another school' using errcode = 'P0001';
  end if;
  update parent_accounts set failed_login_count = 0, locked_until = null, updated_at = now()
   where id = p_parent_id and (failed_login_count > 0 or locked_until is not null);
  return found;
end
$$;

revoke all on function parent_mark_school_used() from public;
revoke all on function school_parent_used_elsewhere(uuid) from public;
revoke all on function school_parent_sign_in_state() from public;
revoke all on function school_clear_parent_lockout(uuid) from public;
