-- 901 · Privacy (BP §16 "Privacy law", "Store policies"; docs/PRIVACY.md; lane A range 900–924).
--   1. Legal links and the consent version: platform settings legal.privacy_url, legal.terms_url,
--      legal.consent_version (public), with a per-school override in school_settings
--      (privacy_policy_url, terms_url, consent_version; NULL = platform value). https:// only.
--      school_legal_terms(school) resolves the effective values (NULL school = platform values).
--   2. Public school branding for sign-in screens: public_school_branding(code) — active, not deleted
--      schools only; name, code, type, colour, logo key and the effective legal links. No ids, no
--      contact data.
--   3. Parent consent records (parent_consents): one row per school, parent and accepted version,
--      with the time, the app that recorded it and the links shown. Parents read their own rows
--      (parent scope, read-only) and add rows only through parent_accept_consent() (active child
--      link in the X-School-Id school, version = the school's current consent version, idempotent).
--      School admins read their school's rows (export); nobody updates or deletes them except the
--      SECURITY DEFINER erase helper, which nulls the network details (IP, user agent).
--   4. Erasure markers: students.erased_at, school_parents.erased_at (irreversible anonymisation by
--      the privacy module), school_redact_parent_consents() and school_erase_parent_account(): the
--      GLOBAL parent identity is anonymised only when no other school holds a live link to it (one
--      school never changes what another school relies on — migration 854 rule).
-- Additive and idempotent (if not exists / or replace / on conflict do nothing).

-- platform_settings is FORCE RLS: the owner needs the system context (definer_access policy).
select set_config('app.actor_role', 'system', true);

-- ───────────── 1. legal links + consent version ─────────────
insert into platform_settings (key, value, description, is_public) values
  ('legal.privacy_url',     'null', 'Privacy policy URL shown in the apps and the web panel (https; schools may override)', true),
  ('legal.terms_url',       'null', 'Terms of use URL shown in the apps and the web panel (https; schools may override)', true),
  ('legal.consent_version', '"1"',  'Version of the parent consent text; changing it asks every parent to consent again', true)
on conflict (key) do nothing;

alter table school_settings add column if not exists privacy_policy_url text;
alter table school_settings add column if not exists terms_url text;
alter table school_settings add column if not exists consent_version text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'school_settings_privacy_url_ck') then
    alter table school_settings add constraint school_settings_privacy_url_ck
      check (privacy_policy_url is null or (privacy_policy_url ~ '^https://[^\s]+$' and length(privacy_policy_url) <= 500));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'school_settings_terms_url_ck') then
    alter table school_settings add constraint school_settings_terms_url_ck
      check (terms_url is null or (terms_url ~ '^https://[^\s]+$' and length(terms_url) <= 500));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'school_settings_consent_version_ck') then
    alter table school_settings add constraint school_settings_consent_version_ck
      check (consent_version is null or consent_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$');
  end if;
end
$$;

-- Effective legal links and consent version of a school (NULL → the platform values). Public
-- information (shown on sign-in screens), so any caller may ask; a deleted school answers platform values.
create or replace function school_legal_terms(p_school_id uuid)
returns table (privacy_url text, terms_url text, consent_version text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with p as (
    select max(case when ps.key = 'legal.privacy_url' and jsonb_typeof(ps.value) = 'string' then ps.value #>> '{}' end) as privacy_url,
           max(case when ps.key = 'legal.terms_url' and jsonb_typeof(ps.value) = 'string' then ps.value #>> '{}' end) as terms_url,
           max(case when ps.key = 'legal.consent_version' and jsonb_typeof(ps.value) = 'string' then ps.value #>> '{}' end) as consent_version
      from platform_settings ps
     where ps.key in ('legal.privacy_url', 'legal.terms_url', 'legal.consent_version')
  ), s as (
    select ss.privacy_policy_url, ss.terms_url, ss.consent_version
      from school_settings ss
      join schools sc on sc.id = ss.school_id and sc.deleted_at is null
     where ss.school_id = p_school_id
  )
  select coalesce((select s.privacy_policy_url from s), p.privacy_url),
         coalesce((select s.terms_url from s), p.terms_url),
         coalesce((select s.consent_version from s), p.consent_version, '1')
    from p
$$;

-- ───────────── 2. public branding by school code ─────────────
create or replace function public_school_branding(p_code text)
returns table (code text, name text, institution_type text, brand_color text, logo_key text, privacy_url text, terms_url text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select s.code, s.name, s.institution_type, s.brand_color, f.key, l.privacy_url, l.terms_url
    from schools s
    left join files f on f.school_id = s.id and f.id = s.logo_file_id and f.status = 'uploaded'
    cross join lateral school_legal_terms(s.id) l
   where s.code = upper(btrim(p_code)) and s.status = 'active' and s.deleted_at is null
$$;

-- ───────────── 3. parent consent records ─────────────
create table if not exists parent_consents (
  id                uuid primary key default uuid_v7(),
  school_id         uuid not null references schools (id),
  parent_account_id uuid not null references parent_accounts (id),
  version           text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  accepted_at       timestamptz not null default now(),
  privacy_url       text,                    -- links in force when the parent accepted
  terms_url         text,
  app_name          text collate "en-US-x-icu" check (app_name is null or app_name in ('driver_app', 'parent_app', 'web_admin')),
  app_version       text check (app_version is null or length(app_version) <= 64),
  ip                inet,                    -- evidence; nulled by erasure (redacted_at)
  user_agent        text check (user_agent is null or length(user_agent) <= 512),
  redacted_at       timestamptz,
  created_at        timestamptz not null default now(),
  constraint parent_consents_version_uq unique (school_id, parent_account_id, version)
);
create index if not exists parent_consents_parent_idx on parent_consents (school_id, parent_account_id, accepted_at desc);

select apply_tenant_rls('parent_consents');
-- Parents (validated X-School-Id context) see their own records only, read-only.
select apply_parent_scope('parent_consents', $p$parent_account_id = nullif(current_setting('app.actor_id', true), '')::uuid$p$);
-- Rows are written only by the SECURITY DEFINER functions below (never by an ordinary statement).
drop policy if exists parent_consents_definer_insert on parent_consents;
create policy parent_consents_definer_insert on parent_consents as restrictive for insert
  with check (current_user <> session_user or current_setting('app.actor_role', true) = 'system');
drop policy if exists parent_consents_definer_update on parent_consents;
create policy parent_consents_definer_update on parent_consents as restrictive for update
  using (current_user <> session_user or current_setting('app.actor_role', true) = 'system');
drop policy if exists parent_consents_definer_delete on parent_consents;
create policy parent_consents_definer_delete on parent_consents as restrictive for delete
  using (current_user <> session_user or current_setting('app.actor_role', true) = 'system');

-- The calling parent accepts the consent version of its X-School-Id school. 42501 without a parent
-- context or an active child link there; P0001 when p_version is not the school's current version.
-- Idempotent: accepting the same version again returns the existing record.
create or replace function parent_accept_consent(p_version text, p_app_name text, p_app_version text, p_ip inet, p_user_agent text)
returns table (id uuid, version text, accepted_at timestamptz, privacy_url text, terms_url text)
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_school uuid := nullif(current_setting('app.school_id', true), '')::uuid;
  v_parent uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_terms record;
begin
  if coalesce(current_setting('app.actor_role', true), '') <> 'parent' or v_school is null or v_parent is null then
    raise exception 'parent_accept_consent: parent context required' using errcode = '42501';
  end if;
  if not exists (select 1 from parent_children_index(v_parent) ix where ix.school_id = v_school) then
    raise exception 'parent_accept_consent: no active child link in this school' using errcode = '42501';
  end if;
  select * into v_terms from school_legal_terms(v_school);
  if p_version is distinct from v_terms.consent_version then
    raise exception 'parent_accept_consent: the consent version changed' using errcode = 'P0001';
  end if;
  insert into parent_consents (school_id, parent_account_id, version, privacy_url, terms_url, app_name, app_version, ip, user_agent)
  values (v_school, v_parent, p_version, v_terms.privacy_url, v_terms.terms_url,
          case when p_app_name in ('driver_app', 'parent_app', 'web_admin') then p_app_name end,
          left(p_app_version, 64), p_ip, left(p_user_agent, 512))
  on conflict on constraint parent_consents_version_uq do nothing;
  return query
    select c.id, c.version, c.accepted_at, c.privacy_url, c.terms_url
      from parent_consents c
     where c.school_id = v_school and c.parent_account_id = v_parent and c.version = p_version;
end
$$;

-- ───────────── 4. erasure ─────────────
alter table students add column if not exists erased_at timestamptz;
alter table school_parents add column if not exists erased_at timestamptz;

-- Nulls the network details of a parent's consent records in the caller's school (erasure); the
-- version and time stay as evidence that consent was given. → rows redacted.
create or replace function school_redact_parent_consents(p_parent_id uuid)
returns integer
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_school uuid := nullif(current_setting('app.school_id', true), '')::uuid;
  v_n integer;
begin
  if coalesce(current_setting('app.actor_role', true), '') not in ('school_admin', 'system') or v_school is null then
    raise exception 'school_redact_parent_consents: school admin context required' using errcode = '42501';
  end if;
  update parent_consents c set ip = null, user_agent = null, redacted_at = coalesce(c.redacted_at, now())
   where c.school_id = v_school and c.parent_account_id = p_parent_id;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- Anonymises the GLOBAL parent identity after the caller's school erased its own school_parents row
-- (erased_at set) — but only when no OTHER school has a live (not deleted) link to the parent: the
-- phone number then becomes a unique placeholder in the unassigned +999 range, name and password are
-- removed, the account is deactivated, its sessions revoked, its devices' push tokens dropped and its
-- OTP codes deleted. → anonymised (false when shared) and the revoked session ids (for sockets).
-- P0002 when the caller's school has not erased this parent.
create or replace function school_erase_parent_account(p_parent_id uuid)
returns table (anonymised boolean, revoked_session_ids uuid[])
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_school uuid := nullif(current_setting('app.school_id', true), '')::uuid;
  v_old_phone text;
  v_phone text;
  v_ids uuid[];
begin
  if coalesce(current_setting('app.actor_role', true), '') not in ('school_admin', 'system') or v_school is null then
    raise exception 'school_erase_parent_account: school admin context required' using errcode = '42501';
  end if;
  if not exists (select 1 from school_parents sp
                  where sp.parent_account_id = p_parent_id and sp.school_id = v_school and sp.erased_at is not null) then
    raise exception 'school_erase_parent_account: parent not erased in this school' using errcode = 'P0002';
  end if;
  select pa.phone into v_old_phone from parent_accounts pa where pa.id = p_parent_id for update;
  if not found then
    raise exception 'school_erase_parent_account: parent not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from school_parents sp
              where sp.parent_account_id = p_parent_id and sp.school_id <> v_school and sp.deleted_at is null) then
    return query select false, array[]::uuid[];
    return;
  end if;
  if v_old_phone like '+999%' and exists (select 1 from parent_accounts pa where pa.id = p_parent_id and not pa.is_active and pa.display_name is null) then
    return query select true, array[]::uuid[]; -- already anonymised (idempotent)
    return;
  end if;
  loop
    v_phone := '+999' || lpad((floor(random() * 1e11))::bigint::text, 11, '0');
    exit when not exists (select 1 from parent_accounts pa where pa.phone = v_phone);
  end loop;
  update parent_accounts
     set phone = v_phone, display_name = null, password_hash = null, preferred_language = 'en',
         is_active = false, failed_login_count = 0, locked_until = null, updated_at = now()
   where id = p_parent_id;
  with revoked as (
    update sessions set revoked_at = now(), revoked_reason = 'privacy_erasure', successor_token_enc = null
     where owner_type = 'parent_account' and owner_id = p_parent_id and revoked_at is null
    returning id
  )
  select coalesce(array_agg(id), array[]::uuid[]) into v_ids from revoked;
  update devices set fcm_token = null, revoked_at = coalesce(revoked_at, now())
   where owner_type = 'parent_account' and owner_id = p_parent_id;
  delete from otp_codes where phone = v_old_phone;
  return query select true, v_ids;
end
$$;

revoke all on function school_legal_terms(uuid) from public;
revoke all on function public_school_branding(text) from public;
revoke all on function parent_accept_consent(text, text, text, inet, text) from public;
revoke all on function school_redact_parent_consents(uuid) from public;
revoke all on function school_erase_parent_account(uuid) from public;
