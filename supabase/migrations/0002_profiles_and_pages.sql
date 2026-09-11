-- Print Counter — richer profiles, per-page selection, and diagnostics.
--
-- Safe to run on top of 0001. Every statement is idempotent.

-- ============================================================
-- Profiles: identity from Clerk + the details a counter needs
-- ============================================================
alter table public.profiles add column if not exists email              text;
alter table public.profiles add column if not exists first_name         text;
alter table public.profiles add column if not exists last_name          text;
alter table public.profiles add column if not exists avatar_url         text;
alter table public.profiles add column if not exists year               text;
alter table public.profiles add column if not exists room               text;
-- No foreign key here on purpose: 0003 renames `counters` to `operators`, and
-- an inline reference to a table that later disappears makes this file unsafe
-- to re-run out of order. The column is unused by the app today.
alter table public.profiles add column if not exists default_counter_id uuid;
alter table public.profiles add column if not exists pref_colour        text not null default 'smart';
alter table public.profiles add column if not exists pref_sides         text not null default 'double';
alter table public.profiles add column if not exists pref_binding       text not null default 'none';
alter table public.profiles add column if not exists updated_at         timestamptz not null default now();
alter table public.profiles add column if not exists last_seen_at       timestamptz not null default now();

create index if not exists profiles_email on public.profiles (email);

-- Touch updated_at on every change, so "saved" is verifiable in the table editor.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ============================================================
-- Per-page selection
-- ============================================================
-- Which pages of the document this line actually prints. Empty means all of
-- them, so existing rows keep their meaning.
alter table public.order_items add column if not exists selected_pages integer[] not null default '{}';

-- ============================================================
-- Self-service diagnostics
-- ============================================================
-- Lets the app show exactly what Postgres thinks the caller is. This is the
-- fastest way to tell "Clerk's Supabase integration is off" (role = anon, or a
-- null subject) from "the migration hasn't run".
create or replace function public.whoami()
returns table (clerk_sub text, pg_role text, jwt_role text, has_profile boolean)
language sql stable security definer set search_path = public as $$
  select
    public.clerk_id(),
    current_user::text,
    coalesce(auth.jwt() ->> 'role', '(none)'),
    exists (select 1 from public.profiles p where p.id = public.clerk_id());
$$;

grant execute on function public.whoami() to anon, authenticated;
