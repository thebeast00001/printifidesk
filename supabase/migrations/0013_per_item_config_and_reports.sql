-- Print Counter — settings per file, and a way to say a print came out wrong.
--
-- Run after 0012.

-- ============================================================
-- 1. Print settings belong to the file, not the order
-- ============================================================
-- One config for the whole job meant a colour cover with a mono body was two
-- separate orders, two tokens and two payments — the most ordinary print job on
-- a campus. `orders.config` stays as the summary the queue card reads; the
-- authoritative per-file settings live here.
alter table public.order_items
  add column if not exists config jsonb not null default '{}'::jsonb;

-- Existing rows inherit what they were actually charged for, so nothing looks
-- retroactively wrong in an order placed last week.
update public.order_items oi
   set config = o.config
  from public.orders o
 where o.id = oi.order_id
   and oi.config = '{}'::jsonb;

comment on column public.order_items.config is
  'Per-file print settings. Falls back to orders.config when empty.';
comment on column public.order_items.price is
  'What this file costs on its own. Meaningful since 0013 — binding and copies '
  'are per file now, so the parts of an order really do have separate prices.';

-- ------------------------------------------------------------
-- Items stop being editable once the order has left the student
-- ------------------------------------------------------------
-- There is no UPDATE policy on this table, so a row cannot be changed after it
-- is written. What was missing was a bound on *when* one could be added: the
-- old policy let a student append a file to an order the operator had already
-- accepted and priced.
drop policy if exists "order items write" on public.order_items;
create policy "order items write" on public.order_items for insert
  with check (exists (
    select 1 from public.orders o
    where o.id = order_id
      and o.user_id = public.clerk_id()
      and o.status = 'placed'
  ));

-- ------------------------------------------------------------
-- Paper is counted per file now
-- ------------------------------------------------------------
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

  -- Duplex halves the sheets, rounded up per file: two 7-page duplex documents
  -- are 4 + 4 sheets, not 7. Rounding the order as a whole would quietly
  -- under-count every multi-file job.
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

  -- An order with no item rows still printed something.
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

  return new;
end;
$$;

-- ============================================================
-- 2. Reporting a bad print
-- ============================================================
-- The operator's refund control shipped in 0011, which is what makes this worth
-- building: until there was something at the other end, a complaint had nowhere
-- to go but back to the desk in person.
create table if not exists public.order_reports (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders on delete cascade,
  user_id     text not null,
  reason      text not null,
  detail      text,
  status      text not null default 'open',   -- open | resolved
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolution  text
);

create index if not exists order_reports_order on public.order_reports (order_id);
create index if not exists order_reports_open on public.order_reports (status, created_at desc);

-- One open report per order. A second complaint about the same job is the same
-- complaint; without this, a frustrated student refreshing the button files ten.
create unique index if not exists order_reports_one_open
  on public.order_reports (order_id) where status = 'open';

alter table public.order_reports enable row level security;

drop policy if exists "reports read" on public.order_reports;
create policy "reports read" on public.order_reports for select
using (
  user_id = public.clerk_id()
  or exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_staff(o.operator_id)
  )
);

-- Only about your own order, and only once it is something you could have
-- collected. There is nothing to report about a job still in the queue.
drop policy if exists "reports write" on public.order_reports;
create policy "reports write" on public.order_reports for insert
with check (
  user_id = public.clerk_id()
  and exists (
    select 1 from public.orders o
    where o.id = order_id
      and o.user_id = public.clerk_id()
      and o.status in ('ready', 'collected', 'failed')
  )
);

-- The operator resolves it. The student deliberately cannot close their own
-- report — that decision is the desk's, and a closed report is what the refund
-- hangs off.
drop policy if exists "staff resolve reports" on public.order_reports;
create policy "staff resolve reports" on public.order_reports for update
using (
  exists (select 1 from public.orders o where o.id = order_id and public.is_staff(o.operator_id))
)
with check (
  exists (select 1 from public.orders o where o.id = order_id and public.is_staff(o.operator_id))
);

-- Stamp the time rather than trusting the client to send it.
create or replace function public.stamp_report_resolution()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'resolved' and old.status <> 'resolved' then
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists order_reports_stamp on public.order_reports;
create trigger order_reports_stamp
  before update on public.order_reports
  for each row execute function public.stamp_report_resolution();

-- The portal reads these live, the same way it reads the queue.
alter table public.order_reports replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'order_reports'
  ) then
    alter publication supabase_realtime add table public.order_reports;
  end if;
end $$;
