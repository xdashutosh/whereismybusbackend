-- 009 · Audit trail (insert-only for the app role — db:setup-roles grants INSERT/SELECT only) and
-- database-backed idempotency records (BP §6.2, §7.2; contract §5).

create table audit_logs (
  id          bigint generated always as identity primary key,
  school_id   uuid references schools (id),                    -- NULL for platform-level actions
  actor_type  text check (actor_type is null or actor_type in ('platform_user', 'user', 'parent_account', 'system')),
  actor_id    uuid,
  actor_name  text,
  ip          inet,
  user_agent  text,
  request_id  text,
  action      text not null check (action ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),   -- 'bus.create', 'bus_document.replace'
  entity_type text,
  entity_id   uuid,
  old_values  jsonb,                                            -- secrets redacted by the API
  new_values  jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_school_created_idx on audit_logs (school_id, created_at desc);
create index audit_logs_school_entity_idx on audit_logs (school_id, entity_type, entity_id);
create index audit_logs_school_action_idx on audit_logs (school_id, action, created_at desc);
create index audit_logs_actor_idx on audit_logs (actor_id, created_at desc) where actor_id is not null;
create index audit_logs_platform_idx on audit_logs (created_at desc) where school_id is null;

-- Optional durable store for Idempotency-Key replays (the default store is the KV store).
create table idempotency_keys (
  id              uuid primary key default uuid_v7(),
  school_id       uuid references schools (id),                -- NULL for platform / parent-global requests
  actor_id        uuid not null,
  idem_key        text not null check (length(idem_key) between 8 and 200),
  method          text not null,
  path            text not null,
  request_hash    text not null,
  status          text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours'
);
create unique index idempotency_keys_scope_uq on idempotency_keys (
  coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid), actor_id, idem_key);
create index idempotency_keys_expires_idx on idempotency_keys (expires_at);

-- updated_at triggers for every table that has the column
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'updated_at' and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r' and not c.relispartition
  loop
    perform apply_updated_at(r.tbl);
  end loop;
end
$$;
