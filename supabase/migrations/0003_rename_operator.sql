-- Print Counter — rename "counter" to "operator".
--
-- The thing that prints your job is a person running a machine, so it's called
-- an operator everywhere now: table, columns, functions and UI.
--
-- Run after 0002. Safe to re-run: every step checks whether it already applied.
--
-- Two Postgres facts shape this file:
--   · Renaming a column carries its policies with it automatically, but
--     function bodies are stored as text, so each function is replaced below.
--   · CREATE OR REPLACE cannot rename an *input parameter*. `is_staff` takes
--     one, so it has to be dropped — and every policy that calls it has to come
--     down first and go back up afterwards.

-- ============================================================
-- Table and columns
-- ============================================================
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'counters')
  then
    alter table public.counters rename to operators;
  end if;
end $$;

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'orders' and column_name = 'counter_id')
  then
    alter table public.orders rename column counter_id to operator_id;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'staff' and column_name = 'counter_id')
  then
    alter table public.staff rename column counter_id to operator_id;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'token_sequence' and column_name = 'counter_id')
  then
    alter table public.token_sequence rename column counter_id to operator_id;
  end if;

  -- Both halves are checked, not just the source. Re-running 0002 after this
  -- migration re-adds `default_counter_id` (its `add column if not exists`
  -- sees nothing, because the column is called something else now), and then a
  -- source-only guard would try to rename it onto the name already in use.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'default_counter_id')
     and not exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'default_operator_id')
  then
    alter table public.profiles rename column default_counter_id to default_operator_id;
  end if;
end $$;

alter index if exists orders_counter_active rename to orders_operator_active;

-- The seeded row, named for what it now is.
update public.operators
   set name = 'Printify Operator, Block C'
 where name = 'Xerox counter, Block C';

-- ============================================================
-- Drop every policy that calls is_staff(), so the function can be replaced
-- ============================================================
-- Both the pre-Clerk and post-Clerk policy names are listed, so this works
-- whichever version of 0001 was applied first.
drop policy if exists "orders read"            on public.orders;
drop policy if exists "own orders read"        on public.orders;
drop policy if exists "staff advance orders"   on public.orders;
drop policy if exists "order items read"       on public.order_items;
drop policy if exists "own order items read"   on public.order_items;
drop policy if exists "order events read"      on public.order_events;
drop policy if exists "own order events read"  on public.order_events;
drop policy if exists "staff update operator"  on public.operators;

drop policy if exists "counters are public"  on public.operators;
drop policy if exists "operators are public" on public.operators;
create policy "operators are public" on public.operators for select using (true);

-- ============================================================
-- Functions
-- ============================================================
drop function if exists public.is_staff(uuid);

create function public.is_staff(p_operator uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = public.clerk_id() and s.operator_id = p_operator
  );
$$;

create or replace function public.assign_order_token()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  if new.token is not null then
    return new;
  end if;

  insert into public.token_sequence (operator_id, day, last_value)
  values (new.operator_id, current_date, 1)
  on conflict (operator_id, day)
    do update set last_value = public.token_sequence.last_value + 1
  returning last_value into n;

  -- A01…A99, then B01… — short enough to read out at a desk.
  new.token := chr(65 + ((n - 1) / 99) % 26) || lpad((((n - 1) % 99) + 1)::text, 2, '0');
  return new;
end;
$$;

-- Dropped rather than replaced: the RETURNS TABLE column names are part of the
-- return type, so they can't be changed in place either.
drop function if exists public.queue_status(uuid);

create function public.queue_status(p_order uuid)
returns table (place integer, pages_ahead integer, wait_minutes integer)
language plpgsql stable security definer set search_path = public as $$
declare
  o public.orders;
  c public.operators;
  ahead integer;
  pos integer;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null then return; end if;
  if o.user_id <> public.clerk_id() and not public.is_staff(o.operator_id) then return; end if;

  select * into c from public.operators where id = o.operator_id;

  select count(*), coalesce(sum(q.pages), 0)
    into pos, ahead
  from public.orders q
  where q.operator_id = o.operator_id
    and q.status in ('queued', 'printing', 'finishing')
    and q.created_at < o.created_at;

  return query select
    pos + 1,
    ahead,
    ceil((ahead + o.pages)::numeric / greatest(c.pages_per_minute, 1))::integer
      + c.handling_minutes;
end;
$$;

drop function if exists public.counter_wait(uuid);
drop function if exists public.operator_wait(uuid);

create function public.operator_wait(p_operator uuid)
returns table (open boolean, pending_orders integer, pending_pages integer, wait_minutes integer)
language plpgsql stable security definer set search_path = public as $$
declare
  c public.operators;
  n integer;
  p integer;
begin
  select * into c from public.operators where id = p_operator;
  if c.id is null then return; end if;

  select count(*), coalesce(sum(o.pages), 0) into n, p
  from public.orders o
  where o.operator_id = p_operator and o.status in ('queued', 'printing', 'finishing');

  return query select
    (localtime between c.opens_at and c.closes_at),
    n,
    p,
    ceil(p::numeric / greatest(c.pages_per_minute, 1))::integer + c.handling_minutes;
end;
$$;

grant execute on function public.operator_wait(uuid) to anon, authenticated;
grant execute on function public.queue_status(uuid)  to anon, authenticated;
grant execute on function public.is_staff(uuid)      to anon, authenticated;

-- ============================================================
-- Put the policies back, now naming operator_id
-- ============================================================
create policy "orders read" on public.orders for select
  using (user_id = public.clerk_id() or public.is_staff(operator_id));

create policy "staff advance orders" on public.orders for update
  using (public.is_staff(operator_id))
  with check (public.is_staff(operator_id));

create policy "order items read" on public.order_items for select
  using (exists (
    select 1 from public.orders o
    where o.id = order_id
      and (o.user_id = public.clerk_id() or public.is_staff(o.operator_id))
  ));

create policy "order events read" on public.order_events for select
  using (exists (
    select 1 from public.orders o
    where o.id = order_id
      and (o.user_id = public.clerk_id() or public.is_staff(o.operator_id))
  ));

-- Restored here too, so re-running 0003 after 0004 doesn't leave the operator
-- unable to open or close Printify. 0004 re-creates it harmlessly.
create policy "staff update operator" on public.operators for update
  using (public.is_staff(id))
  with check (public.is_staff(id));
