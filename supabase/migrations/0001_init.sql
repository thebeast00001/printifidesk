-- Print Counter — schema.
--
-- Authentication is Clerk, wired to Supabase as a third-party auth provider.
-- That has two consequences that shape this whole file:
--
--   1. Users live in Clerk, not `auth.users`, so there is nothing to put a
--      foreign key against. User ids are Clerk's `user_...` strings — text,
--      not uuid.
--   2. `auth.uid()` returns null, because it tries to read a uuid. The subject
--      claim is read directly instead, via public.clerk_id().
--
-- Setup order:
--   a. Supabase → Authentication → Third-Party Auth → add Clerk, domain:
--        factual-teal-4113.clerk.accounts.dev
--   b. Run this file in the SQL editor.
--   c. Sign in once, then add yourself to public.staff (see below).

-- Whoever is making this request, according to the verified Clerk JWT.
create or replace function public.clerk_id()
returns text language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')
$$;

-- ============================================================
-- Counters
-- ============================================================
create table if not exists public.counters (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  campus           text not null,
  opens_at         time not null default '09:00',
  closes_at        time not null default '20:00',
  -- Measured throughput of the printer(s) here. The wait estimate divides by
  -- this, so set it to what the hardware actually does.
  pages_per_minute integer not null default 20,
  -- Fixed overhead per job: fetching, binding, handover.
  handling_minutes integer not null default 3,
  created_at       timestamptz not null default now()
);

alter table public.counters enable row level security;

drop policy if exists "counters are public" on public.counters;
create policy "counters are public" on public.counters for select using (true);

insert into public.counters (name, campus, pages_per_minute)
select 'Xerox counter, Block C', 'Main campus', 20
where not exists (select 1 from public.counters);

-- ============================================================
-- Profiles
-- ============================================================
create table if not exists public.profiles (
  id          text primary key,          -- Clerk user id
  name        text,
  phone       text,
  roll_no     text,
  department  text,
  hostel      text,
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles for select
  using (id = public.clerk_id());

drop policy if exists "own profile write" on public.profiles;
create policy "own profile write" on public.profiles for insert
  with check (id = public.clerk_id());

drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles for update
  using (id = public.clerk_id());

-- ============================================================
-- Staff — who is allowed to run a counter
-- ============================================================
-- Bootstrap after signing in once (your Clerk id is on /profile):
--   insert into public.staff (user_id, counter_id)
--   values ('user_xxx', (select id from public.counters limit 1));
create table if not exists public.staff (
  user_id    text not null,
  counter_id uuid not null references public.counters on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, counter_id)
);

alter table public.staff enable row level security;

drop policy if exists "own staff row" on public.staff;
create policy "own staff row" on public.staff for select
  using (user_id = public.clerk_id());

create or replace function public.is_staff(p_counter uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = public.clerk_id() and s.counter_id = p_counter
  );
$$;

-- ============================================================
-- Documents
-- ============================================================
create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null,
  name         text not null,
  kind         text not null,
  storage_path text not null,
  size_bytes   bigint,
  pages        integer not null default 0,
  colour_pages integer not null default 0,
  -- Which page numbers carry colour, so a re-quote never re-scans the file.
  colour_index integer[] not null default '{}',
  pages_exact  boolean not null default false,
  created_at   timestamptz not null default now(),
  purge_at     timestamptz
);

create index if not exists documents_user_created on public.documents (user_id, created_at desc);

alter table public.documents enable row level security;

drop policy if exists "own documents read" on public.documents;
create policy "own documents read" on public.documents for select
  using (user_id = public.clerk_id());

drop policy if exists "own documents write" on public.documents;
create policy "own documents write" on public.documents for insert
  with check (user_id = public.clerk_id());

drop policy if exists "own documents delete" on public.documents;
create policy "own documents delete" on public.documents for delete
  using (user_id = public.clerk_id());

-- ============================================================
-- Orders
-- ============================================================
do $$ begin
  create type public.order_status as enum (
    'placed',     -- created; payment not collected yet
    'queued',     -- paid at the counter, waiting for a printer
    'printing',
    'finishing',  -- binding, stapling, punching
    'ready',      -- waiting to be collected
    'collected',
    'cancelled',
    'failed'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           text not null,
  counter_id        uuid not null references public.counters on delete restrict,
  token             text,
  status            public.order_status not null default 'placed',
  total             numeric(10, 2) not null default 0,
  -- What full colour would have cost, so the saving is a stored fact rather
  -- than something recomputed differently later.
  full_colour_total numeric(10, 2) not null default 0,
  pages             integer not null default 0,
  colour_pages      integer not null default 0,
  config            jsonb not null default '{}'::jsonb,
  note              text,
  created_at        timestamptz not null default now(),
  queued_at         timestamptz,
  ready_at          timestamptz,
  collected_at      timestamptz
);

create index if not exists orders_user_created on public.orders (user_id, created_at desc);
create index if not exists orders_counter_active on public.orders (counter_id, status, created_at);

alter table public.orders enable row level security;

drop policy if exists "orders read" on public.orders;
create policy "orders read" on public.orders for select
  using (user_id = public.clerk_id() or public.is_staff(counter_id));

drop policy if exists "orders insert" on public.orders;
create policy "orders insert" on public.orders for insert
  with check (user_id = public.clerk_id());

-- A student may only cancel, and only before it reaches a printer.
drop policy if exists "orders cancel" on public.orders;
create policy "orders cancel" on public.orders for update
  using (user_id = public.clerk_id() and status in ('placed', 'queued'))
  with check (user_id = public.clerk_id());

drop policy if exists "staff advance orders" on public.orders;
create policy "staff advance orders" on public.orders for update
  using (public.is_staff(counter_id))
  with check (public.is_staff(counter_id));

-- ---------- tokens are issued by the database ----------
create table if not exists public.token_sequence (
  counter_id uuid not null references public.counters on delete cascade,
  day        date not null,
  last_value integer not null default 0,
  primary key (counter_id, day)
);

create or replace function public.assign_order_token()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  if new.token is not null then
    return new;
  end if;

  insert into public.token_sequence (counter_id, day, last_value)
  values (new.counter_id, current_date, 1)
  on conflict (counter_id, day)
    do update set last_value = public.token_sequence.last_value + 1
  returning last_value into n;

  -- A01…A99, then B01… — short enough to read out at a counter.
  new.token := chr(65 + ((n - 1) / 99) % 26) || lpad((((n - 1) % 99) + 1)::text, 2, '0');
  return new;
end;
$$;

drop trigger if exists orders_assign_token on public.orders;
create trigger orders_assign_token
  before insert on public.orders
  for each row execute function public.assign_order_token();

-- ============================================================
-- Order items
-- ============================================================
create table if not exists public.order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders on delete cascade,
  document_id  uuid references public.documents on delete set null,
  name         text not null,
  pages        integer not null default 0,
  colour_pages integer not null default 0,
  price        numeric(10, 2) not null default 0
);

alter table public.order_items enable row level security;

drop policy if exists "order items read" on public.order_items;
create policy "order items read" on public.order_items for select
  using (exists (
    select 1 from public.orders o
    where o.id = order_id
      and (o.user_id = public.clerk_id() or public.is_staff(o.counter_id))
  ));

drop policy if exists "order items write" on public.order_items;
create policy "order items write" on public.order_items for insert
  with check (exists (
    select 1 from public.orders o
    where o.id = order_id and o.user_id = public.clerk_id()
  ));

-- ============================================================
-- Order events — append-only timeline
-- ============================================================
create table if not exists public.order_events (
  id       bigserial primary key,
  order_id uuid not null references public.orders on delete cascade,
  status   public.order_status not null,
  note     text,
  actor    text,
  at       timestamptz not null default now()
);

create index if not exists order_events_order_at on public.order_events (order_id, at);

alter table public.order_events enable row level security;

drop policy if exists "order events read" on public.order_events;
create policy "order events read" on public.order_events for select
  using (exists (
    select 1 from public.orders o
    where o.id = order_id
      and (o.user_id = public.clerk_id() or public.is_staff(o.counter_id))
  ));

-- Events are written by a trigger, never by a client, so the timeline can't
-- disagree with the order it describes.
create or replace function public.record_order_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (order_id, status, actor, note)
    values (new.id, new.status, public.clerk_id(), 'Order placed');
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.order_events (order_id, status, actor, note)
    values (new.id, new.status, public.clerk_id(), new.note);

    new.queued_at    := coalesce(new.queued_at,    case when new.status = 'queued'    then now() end);
    new.ready_at     := coalesce(new.ready_at,     case when new.status = 'ready'     then now() end);
    new.collected_at := coalesce(new.collected_at, case when new.status = 'collected' then now() end);
  end if;

  return new;
end;
$$;

drop trigger if exists orders_record_insert on public.orders;
create trigger orders_record_insert
  after insert on public.orders
  for each row execute function public.record_order_event();

drop trigger if exists orders_record_update on public.orders;
create trigger orders_record_update
  before update on public.orders
  for each row execute function public.record_order_event();

-- ============================================================
-- Queue maths
-- ============================================================
-- NOTE: the output column is `place`, not `position` — `position` is a
-- reserved word in Postgres and can't name a RETURNS TABLE column.
--
-- A student can't read other people's orders, but they can be told how many are
-- in front of them. Security definer, and it only answers for an order the
-- caller actually owns (or staffs).
create or replace function public.queue_status(p_order uuid)
returns table (place integer, pages_ahead integer, wait_minutes integer)
language plpgsql stable security definer set search_path = public as $$
declare
  o public.orders;
  c public.counters;
  ahead integer;
  pos integer;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null then return; end if;
  if o.user_id <> public.clerk_id() and not public.is_staff(o.counter_id) then return; end if;

  select * into c from public.counters where id = o.counter_id;

  select count(*), coalesce(sum(q.pages), 0)
    into pos, ahead
  from public.orders q
  where q.counter_id = o.counter_id
    and q.status in ('queued', 'printing', 'finishing')
    and q.created_at < o.created_at;

  return query select
    pos + 1,
    ahead,
    ceil((ahead + o.pages)::numeric / greatest(c.pages_per_minute, 1))::integer
      + c.handling_minutes;
end;
$$;

-- What the counter can promise a walk-up right now.
create or replace function public.counter_wait(p_counter uuid)
returns table (open boolean, pending_orders integer, pending_pages integer, wait_minutes integer)
language plpgsql stable security definer set search_path = public as $$
declare
  c public.counters;
  n integer;
  p integer;
begin
  select * into c from public.counters where id = p_counter;
  if c.id is null then return; end if;

  select count(*), coalesce(sum(o.pages), 0) into n, p
  from public.orders o
  where o.counter_id = p_counter and o.status in ('queued', 'printing', 'finishing');

  return query select
    (localtime between c.opens_at and c.closes_at),
    n,
    p,
    ceil(p::numeric / greatest(c.pages_per_minute, 1))::integer + c.handling_minutes;
end;
$$;

-- Lifetime totals for the widgets, without exposing anybody else's rows.
create or replace function public.my_totals()
returns table (orders integer, pages integer, colour_pages integer, spent numeric, saved numeric)
language sql stable security definer set search_path = public as $$
  select
    count(*)::integer,
    coalesce(sum(o.pages), 0)::integer,
    coalesce(sum(o.colour_pages), 0)::integer,
    coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0),
    coalesce(sum(o.full_colour_total - o.total) filter (where o.status <> 'cancelled'), 0)
  from public.orders o
  where o.user_id = public.clerk_id();
$$;

-- ============================================================
-- Realtime — the tracking UI subscribes to these
-- ============================================================
do $$ begin
  alter publication supabase_realtime add table public.orders;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.order_events;
exception when duplicate_object then null;
end $$;

-- ============================================================
-- Storage
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 52428800)
on conflict (id) do nothing;

-- Paths are `<clerk user id>/<document id>-<filename>`, so the first segment is
-- the owner and these policies stay simple.
drop policy if exists "own files read" on storage.objects;
create policy "own files read" on storage.objects for select
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = public.clerk_id());

drop policy if exists "own files upload" on storage.objects;
create policy "own files upload" on storage.objects for insert
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = public.clerk_id());

drop policy if exists "own files delete" on storage.objects;
create policy "own files delete" on storage.objects for delete
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = public.clerk_id());
