-- Print Counter — let the operator actually print, and the things around that.
--
-- Covers: operator file access + audit, editable hours, customer contact,
-- refunds, consumables, longer stats, purge scheduling, push subscriptions.
--
-- Run after 0010.

-- ============================================================
-- 1. The blocker: staff can read the files they have to print
-- ============================================================
-- Until now only the uploader could read a document, so the operator's queue
-- listed filenames it could never open. Access is scoped two ways: to staff of
-- the operator the order was placed with, and to orders that are still live —
-- once a job is collected or cancelled, the file stops being readable.
drop policy if exists "staff read order files" on storage.objects;
create policy "staff read order files" on storage.objects for select
using (
  bucket_id = 'documents'
  and exists (
    select 1
    from public.order_items oi
    join public.orders    o on o.id = oi.order_id
    join public.documents d on d.id = oi.document_id
    where d.storage_path = storage.objects.name
      and public.is_staff(o.operator_id)
      and o.status in ('placed', 'queued', 'printing', 'finishing', 'ready')
  )
);

-- Staff need the document rows too, for the same orders and the same window.
drop policy if exists "staff read order documents" on public.documents;
create policy "staff read order documents" on public.documents for select
using (
  exists (
    select 1
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where oi.document_id = documents.id
      and public.is_staff(o.operator_id)
      and o.status in ('placed', 'queued', 'printing', 'finishing', 'ready')
  )
);

-- ------------------------------------------------------------
-- Every open is recorded and shown back to the student.
-- ------------------------------------------------------------
create table if not exists public.document_access_log (
  id          bigserial primary key,
  document_id uuid not null references public.documents on delete cascade,
  order_id    uuid references public.orders on delete set null,
  actor       text not null,
  purpose     text not null default 'print',
  at          timestamptz not null default now()
);

create index if not exists document_access_document on public.document_access_log (document_id, at desc);

alter table public.document_access_log enable row level security;

-- The owner sees who touched their file; staff see their own actions.
drop policy if exists "access log read" on public.document_access_log;
create policy "access log read" on public.document_access_log for select
using (
  actor = public.clerk_id()
  or exists (select 1 from public.documents d where d.id = document_id and d.user_id = public.clerk_id())
);

/**
 * Records that a staff member opened a document, and hands back the storage
 * path to sign.
 *
 * The honest limit: the storage policy above also permits a direct read, so
 * this logs what the app does rather than making a bypass impossible. Closing
 * that gap means routing downloads through a server holding the service key.
 */
create or replace function public.claim_document_access(p_item uuid, p_purpose text default 'print')
returns table (document_id uuid, storage_path text, name text)
language plpgsql security definer set search_path = public as $$
declare
  ord public.orders;
  doc public.documents;
begin
  select o.* into ord
  from public.order_items oi join public.orders o on o.id = oi.order_id
  where oi.id = p_item;

  if ord.id is null then raise exception 'No such order item'; end if;
  if not public.is_staff(ord.operator_id) then
    raise exception 'Only the operator running this job can open its files';
  end if;
  if ord.status not in ('placed', 'queued', 'printing', 'finishing', 'ready') then
    raise exception 'That order is finished; its files are no longer available';
  end if;

  select d.* into doc
  from public.order_items oi join public.documents d on d.id = oi.document_id
  where oi.id = p_item;

  if doc.id is null then raise exception 'That item has no stored file'; end if;

  insert into public.document_access_log (document_id, order_id, actor, purpose)
  values (doc.id, ord.id, public.clerk_id(), p_purpose);

  return query select doc.id, doc.storage_path, doc.name;
end;
$$;

grant execute on function public.claim_document_access(uuid, text) to authenticated;

-- ============================================================
-- 2. Customer contact on the order card
-- ============================================================
drop policy if exists "staff read customer profile" on public.profiles;
create policy "staff read customer profile" on public.profiles for select
using (
  exists (
    select 1 from public.orders o
    where o.user_id = profiles.id
      and public.is_staff(o.operator_id)
      and o.status in ('placed', 'queued', 'printing', 'finishing', 'ready')
  )
);

-- ============================================================
-- 3. Refunds
-- ============================================================
alter table public.orders add column if not exists refunded_at    timestamptz;
alter table public.orders add column if not exists refund_amount  numeric(10, 2);
alter table public.orders add column if not exists refund_note    text;
-- The UPI reference a student pastes so the operator can match the payment.
alter table public.orders add column if not exists payment_reference text;

-- ============================================================
-- 4. Consumables
-- ============================================================
alter table public.operators add column if not exists paper_stock    integer;
alter table public.operators add column if not exists low_paper_at   integer not null default 100;
alter table public.operators add column if not exists toner_pages    integer;
alter table public.operators add column if not exists low_toner_at   integer not null default 200;

/**
 * Draws down stock when a job is collected, and closes the desk at zero.
 *
 * Counted at collection rather than at print, because that's the point the
 * paper has definitely left the tray. Null stock means "not tracking".
 */
create or replace function public.consume_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  sheets integer;
  op public.operators;
begin
  if new.status <> 'collected' or old.status = 'collected' then
    return new;
  end if;

  select * into op from public.operators where id = new.operator_id;
  if op.id is null then return new; end if;

  -- Duplex halves the sheets, rounded up: 7 pages is 4 sheets, not 3.5.
  sheets := ceil(
    (new.pages * coalesce((new.config ->> 'copies')::integer, 1))::numeric
    / case when new.config ->> 'sides' = 'double' then 2 else 1 end
  );

  update public.operators
     set paper_stock = case when paper_stock is null then null else greatest(paper_stock - sheets, 0) end,
         toner_pages = case when toner_pages is null then null
                            else greatest(toner_pages - (new.pages * coalesce((new.config ->> 'copies')::integer, 1)), 0) end,
         is_open = case
           when (paper_stock is not null and paper_stock - sheets <= 0)
             or (toner_pages is not null and toner_pages - new.pages <= 0)
           then false else is_open end,
         status_note = case
           when paper_stock is not null and paper_stock - sheets <= 0 then 'Out of paper'
           when toner_pages is not null and toner_pages - new.pages <= 0 then 'Out of toner'
           else status_note end
   where id = new.operator_id;

  return new;
end;
$$;

drop trigger if exists orders_consume_stock on public.orders;
create trigger orders_consume_stock
  after update on public.orders
  for each row execute function public.consume_stock();

-- ============================================================
-- 5. Stats over a window, and the end-of-day summary
-- ============================================================
create or replace function public.operator_stats_range(
  p_operator uuid,
  p_from timestamptz,
  p_to   timestamptz default now()
)
returns table (
  orders          integer,
  collected       integer,
  declined        integer,
  pages           integer,
  colour_pages    integer,
  revenue         numeric,
  refunded        numeric,
  cash_total      numeric,
  upi_total       numeric,
  uncollected     integer,
  median_minutes  integer
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff(p_operator) then return; end if;

  return query
  with mine as (
    select * from public.orders o
    where o.operator_id = p_operator and o.created_at >= p_from and o.created_at < p_to
  )
  -- Every column is qualified with `mine.` on purpose: `pages` and
  -- `colour_pages` are output parameter names as well as column names, and
  -- PL/pgSQL raises on the ambiguity instead of guessing.
  select
    (select count(*)::integer from mine),
    (select count(*)::integer from mine where mine.status = 'collected'),
    (select count(*)::integer from mine where mine.status in ('cancelled', 'failed')),
    (select coalesce(sum(mine.pages), 0)::integer from mine where mine.status = 'collected'),
    (select coalesce(sum(mine.colour_pages), 0)::integer from mine where mine.status = 'collected'),
    (select coalesce(sum(mine.total), 0) from mine where mine.status = 'collected'),
    (select coalesce(sum(mine.refund_amount), 0) from mine where mine.refunded_at is not null),
    (select coalesce(sum(mine.total), 0)
       from mine where mine.status = 'collected' and mine.payment_method = 'cash'),
    (select coalesce(sum(mine.total), 0)
       from mine where mine.status = 'collected' and mine.payment_method = 'upi'),
    (select count(*)::integer from mine where mine.status = 'ready'),
    (select coalesce(percentile_cont(0.5) within group (
       order by extract(epoch from (mine.collected_at - mine.created_at)) / 60), 0)::integer
     from mine where mine.collected_at is not null);
end;
$$;

grant execute on function public.operator_stats_range(uuid, timestamptz, timestamptz) to authenticated;

-- ============================================================
-- 6. Purging
-- ============================================================
-- Set when a job is collected, so the sweeper knows what is safe to remove.
create or replace function public.schedule_document_purge()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'collected' and old.status <> 'collected' then
    update public.documents d
       set purge_at = now() + interval '6 hours'
     where d.id in (select oi.document_id from public.order_items oi where oi.order_id = new.id)
       and d.purge_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_schedule_purge on public.orders;
create trigger orders_schedule_purge
  after update on public.orders
  for each row execute function public.schedule_document_purge();

-- ============================================================
-- 7. Web push subscriptions
-- ============================================================
create table if not exists public.push_subscriptions (
  id         bigserial primary key,
  user_id    text not null,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  failed_at  timestamptz
);

create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "own push read" on public.push_subscriptions;
create policy "own push read" on public.push_subscriptions for select
  using (user_id = public.clerk_id());

drop policy if exists "own push write" on public.push_subscriptions;
create policy "own push write" on public.push_subscriptions for insert
  with check (user_id = public.clerk_id());

drop policy if exists "own push delete" on public.push_subscriptions;
create policy "own push delete" on public.push_subscriptions for delete
  using (user_id = public.clerk_id());

-- Queue a push alongside the WhatsApp message, so a student with the tab shut
-- still hears about a job going ready.
alter table public.profiles add column if not exists notify_push boolean not null default true;

create or replace function public.queue_order_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ord  public.orders;
  prof public.profiles;
  op   public.operators;
  msg  text;
begin
  if new.status not in ('queued', 'ready', 'failed', 'collected') then
    return new;
  end if;

  -- Three plain lookups rather than one join reaching into three row
  -- variables. `SELECT a, b.*, c.* INTO x, y, z` does not do what it looks
  -- like: a wildcard expands to that table's columns and INTO pairs targets
  -- with columns one for one, so the second target is handed a single scalar
  -- and rejects it.
  select * into ord from public.orders where id = new.order_id;
  if ord.id is null or ord.user_id is null then
    return new;
  end if;

  select * into prof from public.profiles  where id = ord.user_id;
  select * into op   from public.operators where id = ord.operator_id;

  msg := case new.status
    when 'queued'    then 'Order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                          coalesce(op.short_name, op.name, 'Printify') || '.'
    when 'ready'     then 'Ready to collect. Show token ' || coalesce(ord.token, '') || ' at ' ||
                          coalesce(op.short_name, op.name, 'Printify') || '.'
    when 'collected' then 'Collected. Thanks!'
    else 'We could not print your order' || coalesce(': ' || ord.note, '') || '.'
  end;

  -- WhatsApp
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

  -- Web push, which needs no provider account at all.
  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail)
  values (
    ord.user_id, new.order_id, 'push', null, msg,
    case
      when prof.id is null then 'skipped'
      when coalesce(prof.notify_push, true) = false then 'skipped'
      when not exists (select 1 from public.push_subscriptions s where s.user_id = ord.user_id) then 'skipped'
      else 'queued'
    end,
    case
      when prof.id is null then 'no profile row'
      when coalesce(prof.notify_push, true) = false then 'turned off in settings'
      when not exists (select 1 from public.push_subscriptions s where s.user_id = ord.user_id)
        then 'no device subscribed'
      else null
    end
  );

  return new;
end;
$$;
