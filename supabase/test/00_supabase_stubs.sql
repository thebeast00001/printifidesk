-- Minimal stand-ins for the Supabase-managed objects the migrations touch, so
-- the whole set can be executed against a plain Postgres image.
--
-- This exists to catch the class of error that only shows up at execution time:
-- reserved words, parameter renames, dependency ordering, missing columns.
-- It is a syntax and dependency harness — it does not test RLS behaviour.

create schema if not exists auth;
create schema if not exists storage;

-- The migrations read the JWT through auth.jwt(). Tests override this per case.
create table if not exists auth.jwt_override (claims jsonb);

create or replace function auth.jwt()
returns jsonb language sql stable as $$
  select coalesce((select claims from auth.jwt_override limit 1), '{}'::jsonb)
$$;

-- storage.buckets / storage.objects: only the columns the policies reference.
create table if not exists storage.buckets (
  id              text primary key,
  name            text not null,
  public          boolean not null default false,
  file_size_limit bigint
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets,
  name       text not null,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text)
returns text[] language sql immutable as $$
  select string_to_array(name, '/')
$$;

-- The realtime publication the migrations add tables to.
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- Roles the migrations grant to.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;
