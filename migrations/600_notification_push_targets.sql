-- Notifications (range 600–699): batched parent push targets for the notification engine (BP §11.2,
-- contract §3 round-trip discipline).
--
-- Parents' devices and sessions are school-less rows that RLS (own_rows) shows only to the parent
-- itself, so a school's notification job could only read them one parent per transaction. These two
-- functions give the job ONE statement per delivery run instead, and nothing broader:
--   * only in a school SYSTEM context (app.actor_role = 'system' and app.school_id set) — 42501 otherwise;
--   * only parents with an ACTIVE link to that school (school_parents) and an active account;
--   * only trusted, unrevoked devices bound to a live (unrevoked, unexpired) session of that parent —
--     device rows keep their FCM token after logout, the live session is what stops the push.

-- (parent_account_id, fcm_token) of the given parents' signed-in phones.
create or replace function notification_parent_push_tokens(p_parent_ids uuid[])
returns table (parent_account_id uuid, fcm_token text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_school uuid := nullif(current_setting('app.school_id', true), '')::uuid;
begin
  if coalesce(current_setting('app.actor_role', true), '') <> 'system' or v_school is null then
    raise exception 'notification_parent_push_tokens: school system context required' using errcode = '42501';
  end if;
  return query
    select distinct d.owner_id, d.fcm_token
      from devices d
      join parent_accounts pa on pa.id = d.owner_id and pa.is_active
     where d.owner_type = 'parent_account' and d.owner_id = any (p_parent_ids) and d.school_id is null
       and d.fcm_token is not null and d.revoked_at is null and d.is_trusted
       and exists (select 1 from school_parents sp
                    where sp.parent_account_id = d.owner_id and sp.school_id = v_school
                      and sp.is_active and sp.deleted_at is null)
       and exists (select 1 from sessions s
                    where s.device_id = d.id and s.owner_type = 'parent_account' and s.owner_id = d.owner_id
                      and s.revoked_at is null and s.expires_at > now());
end
$$;

-- Clears FCM tokens the push provider reported as unregistered, on the phones of parents linked to the
-- caller's school only → rows changed.
create or replace function notification_clear_parent_tokens(p_tokens text[])
returns integer
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_school uuid := nullif(current_setting('app.school_id', true), '')::uuid;
  v_count integer;
begin
  if coalesce(current_setting('app.actor_role', true), '') <> 'system' or v_school is null then
    raise exception 'notification_clear_parent_tokens: school system context required' using errcode = '42501';
  end if;
  update devices d
     set fcm_token = null, updated_at = now()
   where d.owner_type = 'parent_account' and d.school_id is null and d.fcm_token = any (p_tokens)
     and exists (select 1 from school_parents sp
                  where sp.parent_account_id = d.owner_id and sp.school_id = v_school and sp.deleted_at is null);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function notification_parent_push_tokens(uuid[]) from public;
revoke all on function notification_clear_parent_tokens(text[]) from public;
