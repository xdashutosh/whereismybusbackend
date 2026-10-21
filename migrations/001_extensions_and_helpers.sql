-- 001 · Extensions and schema helpers (contract §3, §4; BP §6 conventions).
--
-- Conventions for every later migration (core and module ranges):
--   * UUID keys (uuid_v7() default: time-ordered → index locality), timestamptz, citext emails,
--     enums as text + CHECK (values mirror @wimb/shared enums), generated columns STORED.
--   * Validity windows are half-open: valid_from inclusive, valid_to EXCLUSIVE (NULL = open).
--   * Every table with school_id: apply_tenant_rls(table) AND apply_parent_scope(table, …) — a
--     catalog test fails when either is missing.
--   * Never GRANT here: `npm run db:setup-roles` grants the app role after every migrate.

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists btree_gist;
create extension if not exists postgis;

-- Time-ordered UUID (RFC 9562 version 7) built from gen_random_uuid(): the first 48 bits are the
-- Unix epoch in milliseconds and the version nibble is set to 7. Works on PostgreSQL 14–18
-- (uuidv7() is built in only from 18).
create or replace function uuid_v7() returns uuid
language sql volatile parallel safe
as $$
  select encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              placing substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
              from 1 for 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

-- BEFORE UPDATE trigger: keeps updated_at current.
create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Owner-only helper: attaches the set_updated_at trigger to a table.
create or replace function apply_updated_at(p_table regclass) returns void
language plpgsql
set client_min_messages = warning
as $$
begin
  execute format('drop trigger if exists set_updated_at on %s', p_table);
  execute format('create trigger set_updated_at before update on %s for each row execute function set_updated_at()', p_table);
end
$$;

-- Owner-only helper: lets the table OWNER through although RLS is FORCED for it too, in exactly two
-- situations: (1) a SECURITY DEFINER function runs on behalf of another session user
-- (current_user <> session_user — the app role calling auth/platform/job functions), and (2) an
-- owner session (migrations, seeds) explicitly opts into maintenance mode with
-- app.actor_role = 'system'. The policy targets only the owning role, so it is never evaluated for
-- the app role; owner sessions without that context stay subject to the tenant policies.
create or replace function apply_definer_access(p_table regclass) returns void
language plpgsql
set client_min_messages = warning
as $$
declare
  v_owner name := (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = p_table);
begin
  execute format('drop policy if exists definer_access on %s', p_table);
  execute format(
    $f$create policy definer_access on %s as permissive for all to %I
         using (current_user <> session_user or current_setting('app.actor_role', true) = 'system')
         with check (current_user <> session_user or current_setting('app.actor_role', true) = 'system')$f$,
    p_table, v_owner);
end
$$;

-- Owner-only helper (contract §4, BP §4.3): enables + FORCES row level security and creates the
-- tenant_isolation policy (USING and WITH CHECK school_id = app.school_id) plus definer_access.
-- Without app.school_id (super admin, system bootstrap, no context) a table yields zero rows.
create or replace function apply_tenant_rls(p_table regclass) returns void
language plpgsql
set client_min_messages = warning
as $$
begin
  if not exists (select 1 from pg_attribute where attrelid = p_table and attname = 'school_id' and not attisdropped) then
    raise exception 'apply_tenant_rls: % has no school_id column', p_table;
  end if;
  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
  execute format('drop policy if exists tenant_isolation on %s', p_table);
  execute format(
    $f$create policy tenant_isolation on %s as permissive for all
         using (school_id = nullif(current_setting('app.school_id', true), '')::uuid)
         with check (school_id = nullif(current_setting('app.school_id', true), '')::uuid)$f$,
    p_table);
  perform apply_definer_access(p_table);
end
$$;

-- Owner-only helper: RLS + FORCE for a platform (non-tenant) table; policies are table specific.
create or replace function apply_platform_rls(p_table regclass) returns void
language plpgsql
set client_min_messages = warning
as $$
begin
  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
  perform apply_definer_access(p_table);
end
$$;

-- Owner-only helper (BP §4.3 defence in depth): narrows what actor_role = 'parent' can touch inside
-- its validated school context. Creates the RESTRICTIVE policy parent_scope:
--   non-parent roles → unaffected; parents → only rows matching p_predicate (SQL over the table's
--   columns; may reference other RLS tables, whose own policies then apply).
-- p_writable = false (default) makes the table read-only for parents (WITH CHECK false and a
-- restrictive parent_no_delete policy). Predicate 'false' hides the table from parents entirely.
-- CASE guarantees the predicate (and its sub-selects) is never evaluated for other roles or inside
-- SECURITY DEFINER functions (current_user <> session_user), which do their own scoping.
create or replace function apply_parent_scope(p_table regclass, p_predicate text, p_writable boolean default false) returns void
language plpgsql
set client_min_messages = warning
as $$
declare
  v_role constant text := $r$coalesce(current_setting('app.actor_role', true), '')$r$;
begin
  execute format('drop policy if exists parent_scope on %s', p_table);
  execute format('drop policy if exists parent_no_delete on %s', p_table);
  execute format(
    'create policy parent_scope on %s as restrictive for all using (case when %s <> ''parent'' or current_user <> session_user then true else (%s) end) with check (case when %s <> ''parent'' or current_user <> session_user then true else (%s) end)',
    p_table, v_role, p_predicate, v_role, case when p_writable then p_predicate else 'false' end);
  if not p_writable then
    execute format('create policy parent_no_delete on %s as restrictive for delete using (%s <> ''parent'' or current_user <> session_user)', p_table, v_role);
  end if;
end
$$;

revoke all on function apply_updated_at(regclass) from public;
revoke all on function apply_definer_access(regclass) from public;
revoke all on function apply_tenant_rls(regclass) from public;
revoke all on function apply_platform_rls(regclass) from public;
revoke all on function apply_parent_scope(regclass, text, boolean) from public;
