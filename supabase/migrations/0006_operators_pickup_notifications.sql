-- Print Counter — pick an operator, schedule a pickup, get a WhatsApp message.
--
-- Run after 0005.

-- ============================================================
-- 1. Choosing an operator
-- ============================================================
-- `profiles.default_operator_id` already exists (0002, renamed in 0003). Give
-- it back its foreign key now that the table it points at is settled, and let
-- an operator be hidden without deleting its order history.
alter table public.operators add column if not exists is_listed boolean not null default true;
alter table public.operators add column if not exists short_name text;

do $$ begin
  alter table public.profiles
    add constraint profiles_default_operator_fk
    foreign key (default_operator_id) references public.operators on delete set null;
exception when duplicate_object then null;
end $$;

update public.operators set short_name = coalesce(short_name, split_part(name, ',', 1));

-- ============================================================
-- 2. Scheduled pickup
-- ============================================================
alter table public.orders add column if not exists pickup_mode text not null default 'asap';
alter table public.orders add column if not exists pickup_at   timestamptz;

do $$ begin
  alter table public.orders add constraint orders_pickup_mode_valid
    check (pickup_mode in ('asap', 'scheduled'));
exception when duplicate_object then null;
end $$;

do $$ begin
  -- A scheduled order must say when; an asap order must not.
  alter table public.orders add constraint orders_pickup_at_matches_mode
    check ((pickup_mode = 'scheduled') = (pickup_at is not null));
exception when duplicate_object then null;
end $$;

create index if not exists orders_operator_pickup
  on public.orders (operator_id, pickup_at)
  where pickup_mode = 'scheduled';

-- Scheduled jobs shouldn't crowd the live queue estimate until they're due.
-- `queue_status` and `operator_wait` count only what's actually printable now.
create or replace function public.operator_wait(p_operator uuid)
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
  where o.operator_id = p_operator
    and o.status in ('queued', 'printing', 'finishing')
    and (o.pickup_mode = 'asap' or o.pickup_at <= now() + interval '30 minutes');

  return query select
    c.is_open,
    n,
    p,
    ceil(p::numeric / greatest(c.pages_per_minute, 1))::integer + c.handling_minutes;
end;
$$;

grant execute on function public.operator_wait(uuid) to anon, authenticated;

-- ============================================================
-- 3. Notifications
-- ============================================================
alter table public.profiles add column if not exists notify_whatsapp boolean not null default true;

-- Every attempt is recorded, sent or not. Nothing in the UI claims a message
-- was delivered unless there's a row here saying so.
create table if not exists public.notifications (
  id            bigserial primary key,
  user_id       text not null,
  order_id      uuid references public.orders on delete cascade,
  channel       text not null default 'whatsapp',
  to_phone      text,
  body          text not null,
  status        text not null default 'queued',   -- queued | sent | failed | skipped
  detail        text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index if not exists notifications_user_created
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

drop policy if exists "own notifications read" on public.notifications;
create policy "own notifications read" on public.notifications for select
  using (user_id = public.clerk_id());

-- ------------------------------------------------------------
-- Queue a message whenever an order reaches a status worth telling
-- somebody about. Writing the row is the trigger's whole job; delivery is
-- handled out of band by the app, which then marks this row sent or failed.
-- ------------------------------------------------------------
create or replace function public.queue_order_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  prof public.profiles;
  op   public.operators;
  msg  text;
begin
  -- Only the transitions a student actually wants pushed to their phone.
  if new.status not in ('queued', 'ready', 'failed', 'collected') then
    return new;
  end if;

  select * into prof from public.profiles p
    where p.id = (select o.user_id from public.orders o where o.id = new.order_id);
  select * into op from public.operators
    where id = (select o.operator_id from public.orders o where o.id = new.order_id);

  msg := case new.status
    when 'queued'    then 'Order ' || coalesce((select token from public.orders where id = new.order_id), '') ||
                          ' is in the queue at ' || coalesce(op.short_name, op.name, 'Printify') || '.'
    when 'ready'     then 'Ready to collect. Show token ' ||
                          coalesce((select token from public.orders where id = new.order_id), '') ||
                          ' at ' || coalesce(op.short_name, op.name, 'Printify') || '.'
    when 'collected' then 'Collected. Thanks!'
    else 'We could not print your order' ||
         coalesce(': ' || (select note from public.orders where id = new.order_id), '') || '.'
  end;

  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail)
  values (
    prof.id,
    new.order_id,
    'whatsapp',
    prof.phone,
    msg,
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

drop trigger if exists order_events_notify on public.order_events;
create trigger order_events_notify
  after insert on public.order_events
  for each row execute function public.queue_order_notification();

-- The sender claims work with this, so two workers can't send the same message.
create or replace function public.claim_notifications(p_limit integer default 20)
returns setof public.notifications
language sql security definer set search_path = public as $$
  update public.notifications n
     set status = 'sending'
   where n.id in (
     select id from public.notifications
      where status = 'queued'
      order by created_at
      limit greatest(p_limit, 1)
      for update skip locked
   )
  returning n.*;
$$;

create or replace function public.complete_notification(
  p_id bigint, p_status text, p_detail text default null
) returns void
language sql security definer set search_path = public as $$
  update public.notifications
     set status = p_status, detail = p_detail, completed_at = now()
   where id = p_id;
$$;

-- Only the service role runs the sender; students never call these.
revoke execute on function public.claim_notifications(integer) from anon, authenticated;
revoke execute on function public.complete_notification(bigint, text, text) from anon, authenticated;
