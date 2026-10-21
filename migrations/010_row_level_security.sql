-- 010 · Row level security (contract §4, BP §4.3, App. C). Three layers:
--   1. tenant_isolation on EVERY table with school_id (apply_tenant_rls: ENABLE + FORCE),
--   2. platform policies on schools / platform_users / platform_settings / parent_accounts /
--      otp_codes / subscriptions / platform audit rows,
--   3. RESTRICTIVE parent_scope policies: actor_role = 'parent' (inside its validated X-School-Id
--      context) sees only its linked students, their links and live assignments, the assigned
--      buses / routes / stops / school trips, staff assigned to those buses and parent-visible
--      documents. Predicates chain through other RLS tables (buses → student_assignments →
--      students → student_parents → school_parents) without cycles.
-- Contexts: app.school_id, app.actor_id, app.actor_role (transaction-local, set by withTenant).
-- Every RESTRICTIVE policy lets SECURITY DEFINER functions through (current_user <> session_user is
-- true only while a definer function runs for another session user; the app role cannot fake it).

-- School-local date of the current tenant (never the session TimeZone — contract §3).
create or replace function app_local_date() returns date
language sql stable
set search_path = public, pg_temp
as $$
  select (now() at time zone coalesce(
            (select s.timezone from schools s where s.id = nullif(current_setting('app.school_id', true), '')::uuid),
            'Asia/Kolkata'))::date
$$;

-- ───────────── 1. tenant isolation on every school_id table ─────────────
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'school_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
  loop
    perform apply_tenant_rls(r.tbl);
  end loop;
end
$$;

-- ───────────── 2. platform tables ─────────────
select apply_platform_rls('schools');
create policy schools_platform on schools for all
  using (current_setting('app.actor_role', true) = 'super_admin')
  with check (current_setting('app.actor_role', true) = 'super_admin');
create policy schools_own_read on schools for select
  using (id = nullif(current_setting('app.school_id', true), '')::uuid);
create policy schools_own_update on schools for update
  using (id = nullif(current_setting('app.school_id', true), '')::uuid
         and current_setting('app.actor_role', true) in ('school_admin', 'system'))
  with check (id = nullif(current_setting('app.school_id', true), '')::uuid
         and current_setting('app.actor_role', true) in ('school_admin', 'system'));

select apply_platform_rls('platform_users');
create policy platform_users_super_admin on platform_users for all
  using (current_setting('app.actor_role', true) = 'super_admin')
  with check (current_setting('app.actor_role', true) = 'super_admin');

select apply_platform_rls('platform_settings');
create policy platform_settings_super_admin on platform_settings for all
  using (current_setting('app.actor_role', true) = 'super_admin')
  with check (current_setting('app.actor_role', true) = 'super_admin');
create policy platform_settings_public_read on platform_settings for select
  using (is_public);

-- parent_accounts: own row, or school admins / school jobs of a school where the parent is linked.
select apply_platform_rls('parent_accounts');
create policy parent_accounts_self_read on parent_accounts for select
  using (current_setting('app.actor_role', true) = 'parent' and id = nullif(current_setting('app.actor_id', true), '')::uuid);
create policy parent_accounts_self_update on parent_accounts for update
  using (current_setting('app.actor_role', true) = 'parent' and id = nullif(current_setting('app.actor_id', true), '')::uuid)
  with check (current_setting('app.actor_role', true) = 'parent' and id = nullif(current_setting('app.actor_id', true), '')::uuid);
create policy parent_accounts_school_read on parent_accounts for select
  using (current_setting('app.actor_role', true) in ('school_admin', 'system')
         and exists (select 1 from school_parents sp
                     where sp.parent_account_id = parent_accounts.id
                       and sp.school_id = nullif(current_setting('app.school_id', true), '')::uuid));
create policy parent_accounts_school_update on parent_accounts for update
  using (current_setting('app.actor_role', true) in ('school_admin', 'system')
         and exists (select 1 from school_parents sp
                     where sp.parent_account_id = parent_accounts.id
                       and sp.school_id = nullif(current_setting('app.school_id', true), '')::uuid))
  with check (current_setting('app.actor_role', true) in ('school_admin', 'system'));

-- otp_codes: no app-role policy at all; only the SECURITY DEFINER OTP functions touch it.
select apply_platform_rls('otp_codes');

-- Subscriptions are platform-managed: super admins manage every school's plan, schools read their own.
create policy subscriptions_platform on school_subscriptions for all
  using (current_setting('app.actor_role', true) = 'super_admin')
  with check (current_setting('app.actor_role', true) = 'super_admin');
create policy subscriptions_platform_insert on school_subscriptions as restrictive for insert
  with check (current_user <> session_user or current_setting('app.actor_role', true) in ('super_admin', 'system'));
create policy subscriptions_platform_update on school_subscriptions as restrictive for update
  using (current_user <> session_user or current_setting('app.actor_role', true) in ('super_admin', 'system'));
create policy subscriptions_platform_delete on school_subscriptions as restrictive for delete
  using (current_user <> session_user or current_setting('app.actor_role', true) in ('super_admin', 'system'));

-- Audit: school rows via tenant_isolation; platform-level rows (school_id NULL) for super admins;
-- reading is limited to admins and jobs; everyone may append in their own context.
create policy audit_platform_read on audit_logs for select
  using (school_id is null and current_setting('app.actor_role', true) = 'super_admin');
create policy audit_global_insert on audit_logs for insert
  with check (school_id is null and nullif(current_setting('app.school_id', true), '') is null);
create policy audit_readers on audit_logs as restrictive for select
  using (current_user <> session_user or current_setting('app.actor_role', true) in ('school_admin', 'super_admin', 'system'));

-- Own SCHOOL-LESS rows (super admin / parent sessions and devices, parent-global idempotency keys).
-- Rows that carry a school_id stay governed by tenant_isolation alone, so these policies can never
-- be used to read or write another school's rows.
create policy own_rows on sessions for all
  using (school_id is null and owner_id = nullif(current_setting('app.actor_id', true), '')::uuid
         and owner_type = case current_setting('app.actor_role', true)
                            when 'super_admin' then 'platform_user' when 'parent' then 'parent_account' else 'user' end)
  with check (school_id is null and owner_id = nullif(current_setting('app.actor_id', true), '')::uuid
         and owner_type = case current_setting('app.actor_role', true)
                            when 'super_admin' then 'platform_user' when 'parent' then 'parent_account' else 'user' end);
create policy own_rows on devices for all
  using (school_id is null and owner_id = nullif(current_setting('app.actor_id', true), '')::uuid
         and owner_type = case current_setting('app.actor_role', true)
                            when 'super_admin' then 'platform_user' when 'parent' then 'parent_account' else 'user' end)
  with check (school_id is null and owner_id = nullif(current_setting('app.actor_id', true), '')::uuid
         and owner_type = case current_setting('app.actor_role', true)
                            when 'super_admin' then 'platform_user' when 'parent' then 'parent_account' else 'user' end);
-- Drivers/conductors see only their own sessions and devices; school admins and jobs see the school's.
create policy self_or_admin on sessions as restrictive for all
  using (current_user <> session_user
         or coalesce(current_setting('app.actor_role', true), '') in ('school_admin', 'system')
         or owner_id = nullif(current_setting('app.actor_id', true), '')::uuid);
create policy self_or_admin on devices as restrictive for all
  using (current_user <> session_user
         or coalesce(current_setting('app.actor_role', true), '') in ('school_admin', 'system')
         or owner_id = nullif(current_setting('app.actor_id', true), '')::uuid);
-- Parent inbox across all schools (read only; mark-as-read: parent_notifications_mark_read()).
create policy own_rows on parent_notifications for select
  using (current_setting('app.actor_role', true) = 'parent'
         and parent_account_id = nullif(current_setting('app.actor_id', true), '')::uuid);
create policy own_rows on idempotency_keys for all
  using (school_id is null and actor_id = nullif(current_setting('app.actor_id', true), '')::uuid)
  with check (school_id is null and actor_id = nullif(current_setting('app.actor_id', true), '')::uuid);
