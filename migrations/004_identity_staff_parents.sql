-- 004 · School logins, staff, parents (global identity + per-school profile), devices, sessions and
-- OTP codes (BP §4.6, §5, §6.2; contract §6).

-- ───────────── users (school-scoped logins: school_admin, driver, conductor) ─────────────
create table users (
  id                   uuid primary key default uuid_v7(),
  school_id            uuid not null references schools (id),
  role                 text not null check (role in ('school_admin', 'driver', 'conductor')),
  full_name            text not null check (length(btrim(full_name)) between 1 and 200),
  email                citext,
  phone                text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),   -- E.164
  username             citext check (username is null or username ~ '^[A-Za-z0-9._-]{3,40}$'),
  password_hash        text not null,
  pin_hash             text,                                                           -- optional 4–6 digit PIN (staff)
  must_change_password boolean not null default true,
  is_active            boolean not null default true,
  failed_login_count   integer not null default 0 check (failed_login_count >= 0),
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz,
  deleted_at           timestamptz,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (school_id, id),
  constraint users_admin_email_ck check (role <> 'school_admin' or email is not null),
  constraint users_staff_login_ck check (role = 'school_admin' or phone is not null or username is not null)
);
-- School admins: globally unique email (login identifier); staff: unique phone/username per school.
create unique index users_admin_email_uq on users (email) where role = 'school_admin' and deleted_at is null;
create unique index users_staff_phone_uq on users (school_id, phone) where role in ('driver', 'conductor') and deleted_at is null and phone is not null;
create unique index users_staff_username_uq on users (school_id, username) where role in ('driver', 'conductor') and deleted_at is null and username is not null;
create index users_school_role_idx on users (school_id, role, full_name) where deleted_at is null;

-- ───────────── parent_accounts (global identity, unique by phone) ─────────────
create table parent_accounts (
  id                 uuid primary key default uuid_v7(),
  phone              text not null unique check (phone ~ '^\+[1-9][0-9]{6,14}$'),      -- E.164
  display_name       text,
  password_hash      text,                                                            -- optional fallback
  preferred_language text not null default 'en' check (preferred_language in ('en', 'hi')),
  is_active          boolean not null default true,
  failed_login_count integer not null default 0 check (failed_login_count >= 0),
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table school_parents (
  id                uuid primary key default uuid_v7(),
  school_id         uuid not null references schools (id),
  parent_account_id uuid not null references parent_accounts (id),
  full_name         text not null check (length(btrim(full_name)) between 1 and 200),
  email             citext,
  relation          text,
  alternate_phone   text check (alternate_phone is null or alternate_phone ~ '^\+[1-9][0-9]{6,14}$'),
  is_active         boolean not null default true,
  deleted_at        timestamptz,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (school_id, parent_account_id),
  unique (school_id, id)
);
create index school_parents_school_name_idx on school_parents (school_id, full_name) where deleted_at is null;
create index school_parents_account_idx on school_parents (parent_account_id);

-- ───────────── staff ─────────────
create table staff_profiles (
  id                          uuid primary key default uuid_v7(),
  school_id                   uuid not null references schools (id),
  user_id                     uuid unique,
  staff_type                  text not null check (staff_type in ('driver', 'conductor')),
  full_name                   text not null check (length(btrim(full_name)) between 1 and 200),
  photo_file_id               uuid,
  phone                       text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  email                       citext,
  address                     text,                                -- internal only, never parent-visible
  joining_date                date,
  experience_years            numeric(4,1) check (experience_years is null or experience_years between 0 and 60),
  experience_summary          text,
  emergency_contact_name      text,
  emergency_contact_phone     text,
  id_proof_type               text check (id_proof_type is null or id_proof_type in ('aadhaar', 'pan', 'voter_id', 'passport', 'driving_licence', 'other')),
  id_proof_last4              text check (id_proof_last4 is null or id_proof_last4 ~ '^[A-Za-z0-9]{4}$'),  -- never the full number
  id_verification_status      text not null default 'pending' check (id_verification_status in ('pending', 'verified', 'rejected')),
  licence_no                  text,
  licence_rto                 text,
  licence_issue_date          date,
  licence_expiry_date         date,
  licence_verification_status text not null default 'pending' check (licence_verification_status in ('pending', 'verified', 'rejected')),
  is_active                   boolean not null default true,
  deleted_at                  timestamptz,
  created_by                  uuid,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (school_id, id),
  foreign key (school_id, user_id) references users (school_id, id),
  foreign key (school_id, photo_file_id) references files (school_id, id),
  constraint staff_profiles_licence_ck check (licence_expiry_date is null or licence_issue_date is null or licence_expiry_date >= licence_issue_date)
);
create index staff_profiles_school_type_idx on staff_profiles (school_id, staff_type, full_name) where deleted_at is null;
create index staff_profiles_licence_expiry_idx on staff_profiles (school_id, licence_expiry_date) where deleted_at is null and licence_expiry_date is not null;

create table staff_documents (
  id                        uuid primary key default uuid_v7(),
  school_id                 uuid not null references schools (id),
  staff_id                  uuid not null,
  doc_type                  text not null check (doc_type in ('identity', 'licence_front', 'licence_back', 'character_certificate',
                                                              'police_verification', 'training', 'first_aid', 'child_safety', 'other')),
  title                     text,
  doc_number                text,
  issuer                    text,
  issue_date                date,
  expiry_date               date,
  file_id                   uuid,
  verification_status       text not null default 'pending' check (verification_status in ('pending', 'verified', 'rejected')),
  verified_by               uuid,
  verified_at               timestamptz,
  verification_note         text,
  visible_to_parents_status boolean not null default true,
  visible_to_parents_file   boolean not null default false,
  is_current                boolean not null default true,     -- replaced documents stay as history
  replaced_by               uuid,
  deleted_at                timestamptz,
  created_by                uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (school_id, id),
  foreign key (school_id, staff_id) references staff_profiles (school_id, id),
  foreign key (school_id, file_id) references files (school_id, id),
  constraint staff_documents_dates_ck check (expiry_date is null or issue_date is null or expiry_date >= issue_date),
  -- Identity documents are admin-only (BP §12): never parent-visible.
  constraint staff_documents_identity_private_ck check (doc_type <> 'identity' or (not visible_to_parents_file))
);
create index staff_documents_staff_idx on staff_documents (school_id, staff_id, doc_type) where deleted_at is null;
create index staff_documents_expiry_idx on staff_documents (school_id, expiry_date) where is_current and deleted_at is null and expiry_date is not null;
create unique index staff_documents_one_current on staff_documents (staff_id, doc_type)
  where is_current and deleted_at is null and doc_type not in ('training', 'other');

-- ───────────── devices (driver binding, FCM tokens) ─────────────
create table devices (
  id           uuid primary key default uuid_v7(),
  school_id    uuid references schools (id),                 -- NULL for parents / platform users
  owner_type   text not null check (owner_type in ('platform_user', 'user', 'parent_account')),
  owner_id     uuid not null,
  device_uid   text not null check (length(device_uid) between 1 and 200),   -- client-generated deviceId
  platform     text not null check (platform in ('android', 'ios', 'web')),
  device_model text,
  os_version   text,
  app_name     text check (app_name is null or app_name in ('driver_app', 'parent_app', 'web_admin')),
  app_version  text,
  fcm_token    text,
  is_trusted   boolean not null default true,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (owner_type, owner_id, device_uid),
  unique (school_id, id),
  constraint devices_school_ck check ((owner_type = 'user') = (school_id is not null))
);
create index devices_school_idx on devices (school_id, owner_id) where school_id is not null;
create index devices_fcm_idx on devices (fcm_token) where fcm_token is not null;

-- ───────────── sessions (rotating refresh tokens, BP §5.2) ─────────────
create table sessions (
  id             uuid primary key default uuid_v7(),
  owner_type     text not null check (owner_type in ('platform_user', 'user', 'parent_account')),
  owner_id       uuid not null,
  school_id      uuid references schools (id),               -- NULL for super admins and parents
  device_id      uuid references devices (id),
  family_id      uuid not null,                              -- rotation family (reuse → revoke family)
  refresh_hash   text not null unique,
  client         text not null default 'mobile' check (client in ('web', 'mobile')),
  ip             inet,
  user_agent     text,
  app_name       text,
  app_version    text,
  expires_at     timestamptz not null,
  last_used_at   timestamptz,
  rotated_at     timestamptz,                                -- superseded by a newer token of the family
  revoked_at     timestamptz,
  revoked_reason text,
  created_at     timestamptz not null default now(),
  -- School sessions must use a device of the same school (parents/super admins: school_id NULL).
  foreign key (school_id, device_id) references devices (school_id, id),
  constraint sessions_school_ck check ((owner_type = 'user') = (school_id is not null))
);
create index sessions_owner_idx on sessions (owner_type, owner_id) where revoked_at is null;
create index sessions_school_idx on sessions (school_id) where school_id is not null and revoked_at is null;
create index sessions_family_idx on sessions (family_id);
create index sessions_expires_idx on sessions (expires_at);

-- ───────────── otp_codes (parent login; hashed, short-lived) ─────────────
create table otp_codes (
  id           uuid primary key default uuid_v7(),
  phone        text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  purpose      text not null default 'parent_login' check (purpose in ('parent_login', 'password_reset')),
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  consumed_at  timestamptz,
  last_sent_at timestamptz not null default now(),
  send_count   integer not null default 1 check (send_count >= 1),
  request_ip   inet,
  created_at   timestamptz not null default now(),
  unique (phone, purpose)
);
create index otp_codes_expires_idx on otp_codes (expires_at);
