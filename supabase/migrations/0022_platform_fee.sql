-- Print Counter — the platform fee.
--
-- Run after 0021.
--
-- Printify takes a percentage of every order, the way Blinkit's handling
-- charge works: a line on the student's bill, paid in the same UPI tap to
-- the desk, and owed by the desk to the platform. Money never passes
-- through the platform — the desk collects it and settles up — so what this
-- migration adds is the arithmetic and the ledger, both exact to the paisa:
--
--   * platform_settings — one row: the percentage, an optional floor per
--     order, and the VPA desks settle to. Readable by everyone (a quote has
--     to include it), written only by an admin.
--   * orders.platform_fee — computed inside place_order() from the settings
--     at that moment, snapshotted into rate_card, pinned by the guard.
--   * platform_settlements — each payment a desk makes, recorded by the
--     admin who received it. Owed minus settled is the balance.
--
-- The fee is owed on orders that were collected and not fully refunded — a
-- desk that gave the whole amount back owes nothing on it.

-- ============================================================
-- 1. Settings
-- ============================================================
create table if not exists public.platform_settings (
  -- A singleton: the only row has id = true, and the check keeps it so.
  id          boolean primary key default true check (id),
  fee_percent numeric(5,2)  not null default 3.00 check (fee_percent >= 0 and fee_percent <= 25),
  fee_min     numeric(10,2) not null default 0    check (fee_min >= 0),
  payee_vpa   text,
  payee_name  text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

insert into public.platform_settings (id) values (true) on conflict (id) do nothing;

alter table public.platform_settings enable row level security;

drop policy if exists "platform settings are public" on public.platform_settings;
create policy "platform settings are public" on public.platform_settings for select using (true);

create or replace function public.set_platform_fee(
  p_percent numeric, p_min numeric, p_vpa text, p_name text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only the admin can change the platform fee';
  end if;
  if p_percent is null or p_percent < 0 or p_percent > 25 then
    raise exception 'The fee is a percentage between 0 and 25';
  end if;
  if p_min is null or p_min < 0 then
    raise exception 'The minimum fee cannot be negative';
  end if;
  update public.platform_settings
     set fee_percent = round(p_percent, 2),
         fee_min     = round(p_min, 2),
         payee_vpa   = nullif(trim(coalesce(p_vpa, '')), ''),
         payee_name  = nullif(trim(coalesce(p_name, '')), ''),
         updated_by  = public.clerk_id(),
         updated_at  = now()
   where id;
end;
$$;

grant execute on function public.set_platform_fee(numeric, numeric, text, text) to authenticated;
revoke execute on function public.set_platform_fee(numeric, numeric, text, text) from anon;

-- ============================================================
-- 2. The fee on every order
-- ============================================================
alter table public.orders add column if not exists platform_fee numeric(10,2) not null default 0;

/**
 * The fee for a base amount, computed in double precision exactly as the
 * browser does — base × percent ÷ 100, rounded to the paisa, then the floor.
 * Zero on a zero order.
 */
create or replace function public.platform_fee_for(p_base numeric, p_percent numeric, p_min numeric)
returns numeric language sql immutable as $$
  select case
    when coalesce(p_base, 0) <= 0 then 0::numeric
    else greatest(
      public.to_paise((p_base::double precision * p_percent::double precision) / 100),
      public.to_paise(coalesce(p_min, 0)::double precision))
  end
$$;

create or replace function public.place_order(
  p_operator  uuid,
  p_items     jsonb,
  p_pickup_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me           text := public.clerk_id();
  op           public.operators;
  ps           public.platform_settings;
  item         jsonb;
  cfg          jsonb;
  first_cfg    jsonb;
  pg           integer;
  cp           integer;
  copies       integer;
  printed      integer := 0;
  pages_total  integer := 0;
  colour_total integer := 0;
  bulk         double precision;
  subtotal     numeric := 0;
  full_sum     numeric := 0;
  min_order    numeric;
  base         numeric;
  full_base    numeric;
  fee          numeric;
  full_fee     numeric;
  recent       integer;
  new_id       uuid;
  doc          uuid;
  prices       numeric[] := '{}';
begin
  if me is null then
    raise exception 'Sign in to place an order';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order needs at least one file';
  end if;
  if jsonb_array_length(p_items) > 20 then
    raise exception 'At most 20 files in one order — split it in two';
  end if;

  select * into op from public.operators where id = p_operator and is_listed;
  if op.id is null then
    raise exception 'That operator is not taking orders';
  end if;
  select * into ps from public.platform_settings where id;

  if p_pickup_at is not null
     and (p_pickup_at < now() - interval '5 minutes' or p_pickup_at > now() + interval '30 days') then
    raise exception 'Pickup time is out of range';
  end if;

  select count(*) into recent
  from public.orders
  where user_id = me and created_at > now() - interval '1 hour';
  if recent >= 20 then
    raise exception 'That is a lot of orders in an hour. Try again shortly.'
      using errcode = 'check_violation';
  end if;

  -- Pass one: validate, and count the pages that go through the machine.
  for item in select value from jsonb_array_elements(p_items) loop
    cfg    := coalesce(item -> 'config', '{}'::jsonb);
    pg     := (item ->> 'pages')::integer;
    cp     := coalesce((item ->> 'colour_pages')::integer, 0);
    copies := coalesce((cfg ->> 'copies')::integer, 1);

    if pg is null or pg < 1 or pg > 5000 then
      raise exception 'Page count out of range';
    end if;
    if cp < 0 or cp > pg then
      raise exception 'Colour page count out of range';
    end if;
    if copies < 1 or copies > 200 then
      raise exception 'Copies out of range';
    end if;
    if coalesce(cfg ->> 'colour', 'smart') not in ('smart', 'bw', 'full')
       or coalesce(cfg ->> 'sides', 'double') not in ('single', 'double')
       or coalesce(cfg ->> 'binding', 'none') not in ('none', 'staple') then
      raise exception 'Unknown print setting';
    end if;
    if length(coalesce(item ->> 'name', '')) not between 1 and 200 then
      raise exception 'File name missing or too long';
    end if;

    doc := nullif(item ->> 'document_id', '')::uuid;
    if doc is not null and not exists (
      select 1 from public.documents d where d.id = doc and d.user_id = me
    ) then
      raise exception 'That file is not yours';
    end if;

    printed := printed + pg * copies;
  end loop;

  bulk := case when printed >= coalesce(op.bulk_threshold, 100)
               then coalesce(op.bulk_multiplier, 0.92)::double precision
               else 1 end;
  min_order := public.to_paise(coalesce(op.min_order, 0)::double precision);

  -- Pass two: price each line to the paisa and sum the rounded lines, in file
  -- order, exactly as the browser does. The total is a sum of what's shown.
  for item in select value from jsonb_array_elements(p_items) loop
    cfg := coalesce(item -> 'config', '{}'::jsonb);
    pg  := (item ->> 'pages')::integer;
    cp  := coalesce((item ->> 'colour_pages')::integer, 0);

    prices   := prices || public.to_paise(public.price_line(pg, cp, cfg, op, bulk));
    subtotal := subtotal + prices[array_length(prices, 1)];
    full_sum := full_sum + public.to_paise(public.price_line(pg, pg, cfg || '{"colour":"full"}'::jsonb, op, bulk));

    pages_total  := pages_total + pg;
    colour_total := colour_total + cp;
    first_cfg    := coalesce(first_cfg, cfg);
  end loop;

  -- The minimum lifts the lines; the fee sits on top of that. The same two
  -- steps, in the same order, as quoteOrder().
  base      := greatest(subtotal, min_order);
  full_base := greatest(full_sum, min_order);
  fee       := public.platform_fee_for(base,      ps.fee_percent, ps.fee_min);
  full_fee  := public.platform_fee_for(full_base, ps.fee_percent, ps.fee_min);

  insert into public.orders (
    user_id, operator_id, total, full_colour_total, platform_fee, pages, colour_pages, config,
    pickup_mode, pickup_at, rate_card
  ) values (
    me, p_operator,
    base + fee,
    full_base + full_fee,
    fee,
    pages_total, colour_total, first_cfg,
    case when p_pickup_at is null then 'asap' else 'scheduled' end, p_pickup_at,
    jsonb_build_object(
      'currency',             op.currency,
      'bw_per_page',          op.bw_per_page,
      'colour_per_page',      op.colour_per_page,
      'duplex_discount',      op.duplex_discount,
      'staple_price',         op.staple_price,
      'bulk_threshold',       op.bulk_threshold,
      'bulk_multiplier',      op.bulk_multiplier,
      'min_order',            op.min_order,
      'paper_gsm',            op.paper_gsm,
      'platform_fee_percent', ps.fee_percent,
      'platform_fee_min',     ps.fee_min
    )
  )
  returning id into new_id;

  pg := 0; -- reused as the index into prices
  for item in select value from jsonb_array_elements(p_items) loop
    pg  := pg + 1;
    cfg := coalesce(item -> 'config', '{}'::jsonb);

    insert into public.order_items (
      order_id, document_id, name, pages, colour_pages, selected_pages, config, price, ordinal
    ) values (
      new_id,
      nullif(item ->> 'document_id', '')::uuid,
      item ->> 'name',
      (item ->> 'pages')::integer,
      coalesce((item ->> 'colour_pages')::integer, 0),
      coalesce(
        (select array_agg(x::integer)
           from jsonb_array_elements_text(coalesce(item -> 'selected_pages', '[]'::jsonb)) x),
        '{}'::integer[]
      ),
      cfg,
      prices[pg],
      pg
    );
  end loop;

  return new_id;
end;
$$;

-- The guard pins the fee like every other priced column.
create or replace function public.guard_order_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_staff(new.operator_id) then
    if new.status = 'queued' and old.status <> 'queued' then
      new.payment_taken_at := coalesce(new.payment_taken_at, now());
    end if;
    return new;
  end if;

  new.operator_id       := old.operator_id;
  new.user_id           := old.user_id;
  new.token             := old.token;
  new.handover_code     := old.handover_code;
  new.rate_card         := old.rate_card;
  new.total             := old.total;
  new.full_colour_total := old.full_colour_total;
  new.platform_fee      := old.platform_fee;
  new.pages             := old.pages;
  new.colour_pages      := old.colour_pages;
  new.config            := old.config;
  new.pickup_mode       := old.pickup_mode;
  new.pickup_at         := old.pickup_at;
  new.is_priority       := old.is_priority;
  new.operator_note     := old.operator_note;
  new.payment_taken_at  := old.payment_taken_at;
  new.accepted_at       := old.accepted_at;
  new.started_at        := old.started_at;
  new.ready_at          := old.ready_at;
  new.collected_at      := old.collected_at;
  new.refunded_at       := old.refunded_at;
  new.refund_amount     := old.refund_amount;
  new.refund_note       := old.refund_note;

  if old.payment_taken_at is not null then
    new.payment_reference := old.payment_reference;
  end if;

  if new.status is distinct from old.status then
    if new.status <> 'cancelled' then
      raise exception 'You can only cancel this order';
    end if;
    new.cancelled_by := 'student';
  end if;

  return new;
end;
$$;

-- ============================================================
-- 3. The ledger: what's owed, what's been settled
-- ============================================================
create table if not exists public.platform_settlements (
  id          bigserial primary key,
  operator_id uuid not null references public.operators on delete cascade,
  amount      numeric(10,2) not null check (amount > 0),
  note        text check (note is null or length(note) <= 200),
  recorded_by text not null,
  created_at  timestamptz not null default now()
);

create index if not exists platform_settlements_operator on public.platform_settlements (operator_id, created_at desc);

alter table public.platform_settlements enable row level security;

-- The desk sees its own payments; the admin sees every desk's.
drop policy if exists "settlements read" on public.platform_settlements;
create policy "settlements read" on public.platform_settlements for select
  using (public.is_staff(operator_id) or public.is_admin());

/** A payment received from a desk, recorded by the admin who received it. */
create or replace function public.record_settlement(p_operator uuid, p_amount numeric, p_note text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  new_id bigint;
begin
  if not public.is_admin() then
    raise exception 'Only the admin can record a settlement';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'A settlement is a positive amount';
  end if;
  if not exists (select 1 from public.operators where id = p_operator) then
    raise exception 'No such desk';
  end if;
  insert into public.platform_settlements (operator_id, amount, note, recorded_by)
  values (p_operator, round(p_amount, 2), nullif(trim(coalesce(p_note, '')), ''), public.clerk_id())
  returning id into new_id;
  return new_id;
end;
$$;

/**
 * Fee owed for orders collected in a window. Staff of the desk, or the admin.
 * Collected and not fully refunded — the two conditions everything below
 * shares, so they live in one place.
 */
create or replace function public.fee_window(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (orders integer, fee numeric)
language sql stable security definer set search_path = public as $$
  select count(*)::integer, coalesce(sum(o.platform_fee), 0)::numeric
    from public.orders o
   where o.operator_id = p_operator
     and (public.is_staff(p_operator) or public.is_admin())
     and o.status = 'collected'
     and o.collected_at >= p_from and o.collected_at < p_to
     and (o.refund_amount is null or o.refund_amount < o.total);
$$;

/** All-time owed, settled, and the difference. Staff of the desk, or the admin. */
create or replace function public.fee_balance(p_operator uuid)
returns table (accrued numeric, settled numeric, outstanding numeric)
language sql stable security definer set search_path = public as $$
  with a as (
    select coalesce(sum(o.platform_fee), 0)::numeric as v
      from public.orders o
     where o.operator_id = p_operator
       and o.status = 'collected'
       and (o.refund_amount is null or o.refund_amount < o.total)
  ), s as (
    select coalesce(sum(p.amount), 0)::numeric as v
      from public.platform_settlements p where p.operator_id = p_operator
  )
  select a.v, s.v, a.v - s.v from a, s
   where public.is_staff(p_operator) or public.is_admin();
$$;

/** Every desk in one window, with its all-time balance. Admin only. */
create or replace function public.admin_fee_desks(p_from timestamptz, p_to timestamptz default now())
returns table (
  operator_id uuid, name text, campus text,
  orders integer, fee numeric,
  accrued numeric, settled numeric, outstanding numeric
)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.campus,
         (select count(*)::integer from public.orders x
           where x.operator_id = o.id and x.status = 'collected'
             and x.collected_at >= p_from and x.collected_at < p_to
             and (x.refund_amount is null or x.refund_amount < x.total)),
         (select coalesce(sum(x.platform_fee), 0)::numeric from public.orders x
           where x.operator_id = o.id and x.status = 'collected'
             and x.collected_at >= p_from and x.collected_at < p_to
             and (x.refund_amount is null or x.refund_amount < x.total)),
         b.accrued, b.settled, b.outstanding
    from public.operators o
    cross join lateral public.fee_balance(o.id) b
   where public.is_admin()
   order by o.created_at;
$$;

grant execute on function public.record_settlement(uuid, numeric, text)       to authenticated;
grant execute on function public.fee_window(uuid, timestamptz, timestamptz)   to authenticated;
grant execute on function public.fee_balance(uuid)                            to authenticated;
grant execute on function public.admin_fee_desks(timestamptz, timestamptz)    to authenticated;
revoke execute on function public.record_settlement(uuid, numeric, text)      from anon;
revoke execute on function public.fee_window(uuid, timestamptz, timestamptz)  from anon;
revoke execute on function public.fee_balance(uuid)                           from anon;
revoke execute on function public.admin_fee_desks(timestamptz, timestamptz)   from anon;
revoke execute on function public.platform_fee_for(numeric, numeric, numeric) from public, anon, authenticated;

-- ============================================================
-- 4. Takings know the fee
-- ============================================================
-- RETURNS TABLE changed, so the function is dropped and put back with the
-- fee as one more column. Every caller reads it by name.
drop function if exists public.operator_stats_range(uuid, timestamptz, timestamptz);
create function public.operator_stats_range(
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
  median_minutes  integer,
  platform_fee    numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff(p_operator) then return; end if;

  return query
  with mine as (
    select * from public.orders o
    where o.operator_id = p_operator and o.created_at >= p_from and o.created_at < p_to
  )
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
     from mine where mine.collected_at is not null),
    (select coalesce(sum(mine.platform_fee), 0) from mine
      where mine.status = 'collected'
        and (mine.refund_amount is null or mine.refund_amount < mine.total));
end;
$$;

grant execute on function public.operator_stats_range(uuid, timestamptz, timestamptz) to authenticated;
