-- Print Counter — the tools a desk uses between orders.
--
-- Messages to a student, a stock ledger, staff you can add without SQL, and
-- closing out the day. Run after 0014.

-- ============================================================
-- 1. A message from the desk to the student
-- ============================================================
-- Half of every failed job is a question that never got asked: "page 3 is
-- blank — print it anyway?" `operator_note` is private. This isn't.
create table if not exists public.order_messages (
  id         bigserial primary key,
  order_id   uuid not null references public.orders on delete cascade,
  sender     text not null,
  body       text not null check (length(body) between 1 and 500),
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

create index if not exists order_messages_order on public.order_messages (order_id, created_at);

alter table public.order_messages enable row level security;

drop policy if exists "messages read" on public.order_messages;
create policy "messages read" on public.order_messages for select
using (exists (
  select 1 from public.orders o
  where o.id = order_id
    and (o.user_id = public.clerk_id() or public.is_staff(o.operator_id))
));

-- Only the desk writes; the student's replies are the report and the phone.
drop policy if exists "staff send messages" on public.order_messages;
create policy "staff send messages" on public.order_messages for insert
with check (
  sender = public.clerk_id()
  and exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_staff(o.operator_id)
  )
);

-- The student may mark their own messages read, and nothing else.
drop policy if exists "student reads messages" on public.order_messages;
create policy "student reads messages" on public.order_messages for update
using (exists (select 1 from public.orders o where o.id = order_id and o.user_id = public.clerk_id()))
with check (exists (select 1 from public.orders o where o.id = order_id and o.user_id = public.clerk_id()));

-- A message is worth a push. Same queue, same dispatcher, same honesty about
-- whether it was delivered.
create or replace function public.queue_message_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ord  public.orders;
  prof public.profiles;
  op   public.operators;
  msg  text;
begin
  select * into ord from public.orders where id = new.order_id;
  if ord.id is null or ord.user_id is null then return new; end if;

  select * into prof from public.profiles  where id = ord.user_id;
  select * into op   from public.operators where id = ord.operator_id;

  msg := coalesce(op.short_name, op.name, 'Printify') || ' about order '
      || coalesce(ord.token, '') || ': ' || new.body;

  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail)
  values (
    ord.user_id, new.order_id, 'push', null, msg,
    case
      when coalesce(prof.notify_push, true) = false then 'skipped'
      when not exists (select 1 from public.push_subscriptions s where s.user_id = ord.user_id) then 'skipped'
      else 'queued'
    end,
    case
      when coalesce(prof.notify_push, true) = false then 'turned off in settings'
      when not exists (select 1 from public.push_subscriptions s where s.user_id = ord.user_id) then 'no device subscribed'
      else null
    end
  );

  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail)
  values (
    ord.user_id, new.order_id, 'whatsapp', prof.phone, msg,
    case
      when prof.id is null then 'skipped'
      when coalesce(prof.notify_whatsapp, true) = false then 'skipped'
      when prof.phone is null or length(trim(prof.phone)) < 8 then 'skipped'
      else 'queued'
    end,
    case
      when prof.id is null then 'no profile row'
      when coalesce(prof.notify_whatsapp, true) = false then 'turned off in settings'
      when prof.phone is null or length(trim(prof.phone)) < 8 then 'no phone number saved'
      else null
    end
  );

  return new;
end;
$$;

drop trigger if exists order_messages_notify on public.order_messages;
create trigger order_messages_notify
  after insert on public.order_messages
  for each row execute function public.queue_message_notification();

alter table public.order_messages replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_messages'
  ) then
    alter publication supabase_realtime add table public.order_messages;
  end if;
end $$;

-- ============================================================
-- 2. Stock is a ledger, not a number you overwrite
-- ============================================================
create table if not exists public.stock_log (
  id          bigserial primary key,
  operator_id uuid not null references public.operators on delete cascade,
  paper_delta integer not null default 0,
  toner_delta integer not null default 0,
  note        text check (note is null or length(note) <= 200),
  -- Null actor means the system: paper leaving the tray as a job is collected.
  actor       text,
  order_id    uuid references public.orders on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists stock_log_operator on public.stock_log (operator_id, created_at desc);

alter table public.stock_log enable row level security;

drop policy if exists "staff read stock log" on public.stock_log;
create policy "staff read stock log" on public.stock_log for select
  using (public.is_staff(operator_id));

-- No insert policy: rows come from the RPC below and the collection trigger.

/**
 * Records paper or toner going in (positive) or being written off (negative),
 * and moves the live count. Clears an automatic "Out of paper" note once
 * there is paper again, but does not reopen the desk — that's still a
 * person's decision.
 */
create or replace function public.adjust_stock(
  p_operator uuid,
  p_paper    integer default 0,
  p_toner    integer default 0,
  p_note     text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  me text := public.clerk_id();
begin
  if me is null or not public.is_staff(p_operator) then
    raise exception 'Only staff can adjust stock';
  end if;
  if coalesce(p_paper, 0) = 0 and coalesce(p_toner, 0) = 0 then
    raise exception 'Nothing to record';
  end if;
  if abs(coalesce(p_paper, 0)) > 100000 or abs(coalesce(p_toner, 0)) > 100000 then
    raise exception 'That is not a plausible quantity';
  end if;

  update public.operators
     set paper_stock = case when p_paper <> 0
                            then greatest(coalesce(paper_stock, 0) + p_paper, 0)
                            else paper_stock end,
         toner_pages = case when p_toner <> 0
                            then greatest(coalesce(toner_pages, 0) + p_toner, 0)
                            else toner_pages end,
         status_note = case
           when p_paper > 0 and status_note = 'Out of paper' then null
           when p_toner > 0 and status_note = 'Out of toner' then null
           else status_note end
   where id = p_operator;

  insert into public.stock_log (operator_id, paper_delta, toner_delta, note, actor)
  values (p_operator, coalesce(p_paper, 0), coalesce(p_toner, 0), nullif(trim(p_note), ''), me);
end;
$$;

grant execute on function public.adjust_stock(uuid, integer, integer, text) to authenticated;
revoke execute on function public.adjust_stock(uuid, integer, integer, text) from anon;

-- The collection trigger from 0013, now writing the ledger too.
create or replace function public.consume_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  sheets integer;
  inked  integer;
  op public.operators;
begin
  if new.status <> 'collected' or old.status = 'collected' then
    return new;
  end if;

  select * into op from public.operators where id = new.operator_id;
  if op.id is null then return new; end if;

  select
    coalesce(sum(ceil(
      (oi.pages * coalesce((coalesce(nullif(oi.config, '{}'::jsonb), new.config) ->> 'copies')::integer, 1))::numeric
      / case when coalesce(nullif(oi.config, '{}'::jsonb), new.config) ->> 'sides' = 'double' then 2 else 1 end
    )), 0)::integer,
    coalesce(sum(
      oi.pages * coalesce((coalesce(nullif(oi.config, '{}'::jsonb), new.config) ->> 'copies')::integer, 1)
    ), 0)::integer
  into sheets, inked
  from public.order_items oi
  where oi.order_id = new.id;

  if sheets = 0 then
    sheets := ceil(
      (new.pages * coalesce((new.config ->> 'copies')::integer, 1))::numeric
      / case when new.config ->> 'sides' = 'double' then 2 else 1 end
    );
    inked := new.pages * coalesce((new.config ->> 'copies')::integer, 1);
  end if;

  update public.operators
     set paper_stock = case when paper_stock is null then null else greatest(paper_stock - sheets, 0) end,
         toner_pages = case when toner_pages is null then null
                            else greatest(toner_pages - inked, 0) end,
         is_open = case
           when (paper_stock is not null and paper_stock - sheets <= 0)
             or (toner_pages is not null and toner_pages - inked <= 0)
           then false else is_open end,
         status_note = case
           when paper_stock is not null and paper_stock - sheets <= 0 then 'Out of paper'
           when toner_pages is not null and toner_pages - inked <= 0 then 'Out of toner'
           else status_note end
   where id = new.operator_id;

  -- Only a desk that tracks stock gets ledger rows; otherwise it's noise.
  if op.paper_stock is not null or op.toner_pages is not null then
    insert into public.stock_log (operator_id, paper_delta, toner_delta, note, actor, order_id)
    values (
      new.operator_id,
      case when op.paper_stock is not null then -sheets else 0 end,
      case when op.toner_pages is not null then -inked  else 0 end,
      'Order ' || coalesce(new.token, '') || ' collected',
      null,
      new.id
    );
  end if;

  return new;
end;
$$;

-- ============================================================
-- 3. Staff, without the SQL editor
-- ============================================================
create or replace function public.list_staff(p_operator uuid)
returns table (user_id text, name text, email text, joined_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff(p_operator) then return; end if;
  return query
    select s.user_id, p.name, p.email, s.created_at
      from public.staff s
      left join public.profiles p on p.id = s.user_id
     where s.operator_id = p_operator
     order by s.created_at;
end;
$$;

/**
 * Adds a colleague by the email they signed in with. They must have opened
 * Printify once — that's what creates the profile row the lookup needs — and
 * the error says so rather than "not found".
 */
create or replace function public.add_staff(p_operator uuid, p_email text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  target text;
begin
  if not public.is_staff(p_operator) then
    raise exception 'Only staff can add staff';
  end if;

  select id into target from public.profiles
   where lower(email) = lower(trim(p_email))
   limit 1;

  if target is null then
    raise exception 'No Printify account with that email. They need to sign in once first.';
  end if;

  insert into public.staff (user_id, operator_id)
  values (target, p_operator)
  on conflict do nothing;

  return target;
end;
$$;

create or replace function public.remove_staff(p_operator uuid, p_user text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff(p_operator) then
    raise exception 'Only staff can remove staff';
  end if;
  -- A desk with nobody on it can never be reopened from the app.
  if (select count(*) from public.staff where operator_id = p_operator) <= 1 then
    raise exception 'That would leave nobody running this desk';
  end if;
  delete from public.staff where operator_id = p_operator and user_id = p_user;
end;
$$;

grant execute on function public.list_staff(uuid)          to authenticated;
grant execute on function public.add_staff(uuid, text)     to authenticated;
grant execute on function public.remove_staff(uuid, text)  to authenticated;
revoke execute on function public.list_staff(uuid)         from anon;
revoke execute on function public.add_staff(uuid, text)    from anon;
revoke execute on function public.remove_staff(uuid, text) from anon;

-- ============================================================
-- 4. Closing out the day
-- ============================================================
create table if not exists public.desk_closeouts (
  id            bigserial primary key,
  operator_id   uuid not null references public.operators on delete cascade,
  day           date not null,
  expected_cash numeric(10,2) not null default 0,
  counted_cash  numeric(10,2),
  upi_total     numeric(10,2) not null default 0,
  orders        integer not null default 0,
  uncollected   integer not null default 0,
  note          text check (note is null or length(note) <= 500),
  actor         text not null,
  created_at    timestamptz not null default now(),
  -- Closing twice in a day replaces the first count; a day has one close.
  unique (operator_id, day)
);

alter table public.desk_closeouts enable row level security;

drop policy if exists "staff read closeouts" on public.desk_closeouts;
create policy "staff read closeouts" on public.desk_closeouts for select
  using (public.is_staff(operator_id));

/**
 * Snapshots today's figures, records what was actually in the drawer, and
 * closes the desk. The expected numbers come from `operator_stats_range` so
 * the count the operator sees is the count that gets stored.
 */
create or replace function public.close_desk(
  p_operator     uuid,
  p_counted_cash numeric default null,
  p_note         text default null
) returns public.desk_closeouts
language plpgsql security definer set search_path = public as $$
declare
  me     text := public.clerk_id();
  stats  record;
  result public.desk_closeouts;
begin
  if me is null or not public.is_staff(p_operator) then
    raise exception 'Only staff can close the desk';
  end if;

  select * into stats
    from public.operator_stats_range(p_operator, date_trunc('day', now()), now());

  insert into public.desk_closeouts
    (operator_id, day, expected_cash, counted_cash, upi_total, orders, uncollected, note, actor)
  values
    (p_operator, current_date,
     coalesce(stats.cash_total, 0), p_counted_cash, coalesce(stats.upi_total, 0),
     coalesce(stats.orders, 0), coalesce(stats.uncollected, 0),
     nullif(trim(p_note), ''), me)
  on conflict (operator_id, day) do update
    set expected_cash = excluded.expected_cash,
        counted_cash  = excluded.counted_cash,
        upi_total     = excluded.upi_total,
        orders        = excluded.orders,
        uncollected   = excluded.uncollected,
        note          = excluded.note,
        actor         = excluded.actor,
        created_at    = now()
  returning * into result;

  update public.operators
     set is_open = false,
         status_note = coalesce(status_note, 'Closed for today')
   where id = p_operator;

  return result;
end;
$$;

grant execute on function public.close_desk(uuid, numeric, text) to authenticated;
revoke execute on function public.close_desk(uuid, numeric, text) from anon;
