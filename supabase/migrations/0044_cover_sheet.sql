-- 0044: every job comes out of the printer already labelled.
--
-- Run after 0043.
--
-- The desks' second objection: fifty printed piles look alike, and the
-- identifier lived on a phone screen. Now the file the desk opens to print
-- is a bundle — a cover sheet first, then the document — so the pile has
-- its own label in ink: the token in big type, the student's first name,
-- pages and settings, the shelf slot, what's owed in cash, and a QR the
-- desk can scan to file it or to find it. The bundle is made by the server
-- (/api/print) from the same file the desk always opened; nothing here
-- changes what is printed, only what comes out first.
--
--   operators.cover_sheet / cover_price   the desk's switch and its price for
--                                         the sheet (₹1 by default), the
--                                         owner's to change
--   orders.cover_charge                   the line on the bill, priced with
--                                         the rest inside the subtotal, so
--                                         the minimum and the fee treat it
--                                         like any other line; snapshotted
--   the shelf slot is assigned when the job enters the queue, not when it's
--   ready, so the cover can carry it; a job that finds every slot taken gets
--   one at 'ready' as before.
--
-- The cover's QR carries the token and the desk only — never the handover
-- secret. A found cover sheet proves nothing; the student's phone still does.

begin;

alter table public.operators
  add column if not exists cover_sheet boolean not null default true,
  add column if not exists cover_price numeric(10,2) not null default 1.00 check (cover_price >= 0 and cover_price <= 20);

alter table public.orders
  add column if not exists cover_charge numeric(10,2) not null default 0 check (cover_charge >= 0);

-- ============================================================
-- 1. Pricing: the cover is a line
-- ============================================================
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
  cover        numeric := 0;
  full_sum     numeric := 0;
  min_order    numeric;
  base         numeric;
  full_base    numeric;
  fee          numeric;
  full_fee     numeric;
  total        numeric;
  full_total   numeric;
  rounding     numeric := 0;
  recent       integer;
  new_id       uuid;
  doc          uuid;
  prices       numeric[] := '{}';
  x            text;
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
    -- Extras: each one the desk offers today, no repeats.
    if cfg ? 'extras' then
      if jsonb_typeof(cfg -> 'extras') <> 'array' then
        raise exception 'Unknown print setting';
      end if;
      for x in select jsonb_array_elements_text(cfg -> 'extras') loop
        if not exists (select 1 from jsonb_array_elements(coalesce(op.extras, '[]'::jsonb)) e where e ->> 'id' = x) then
          raise exception 'This desk doesn''t offer that extra any more — check the options';
        end if;
      end loop;
      if (select count(distinct v) from jsonb_array_elements_text(cfg -> 'extras') v)
         <> jsonb_array_length(cfg -> 'extras') then
        raise exception 'Unknown print setting';
      end if;
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

  -- 0044: the cover sheet the job comes out under — one line, the desk's
  -- price for it (₹1 by default), inside the subtotal like any other line,
  -- so the minimum and the fee treat it as they treat the rest.
  if coalesce(op.cover_sheet, true) then
    cover := public.to_paise(coalesce(op.cover_price, 0)::double precision);
  end if;
  subtotal := subtotal + cover;
  full_sum := full_sum + cover;

  base      := greatest(subtotal, min_order);
  full_base := greatest(full_sum, min_order);
  fee       := public.platform_fee_for(base,      ps.fee_percent, ps.fee_min);
  full_fee  := public.platform_fee_for(full_base, ps.fee_percent, ps.fee_min);

  total      := base + fee;
  full_total := full_base + full_fee;
  if op.round_to_rupee then
    rounding   := ceil(total) - total;
    total      := ceil(total);
    full_total := ceil(full_total);
  end if;

  insert into public.orders (
    user_id, operator_id, total, full_colour_total, platform_fee, rounding, pages, colour_pages, config,
    pickup_mode, pickup_at, rate_card, cover_charge
  ) values (
    me, p_operator,
    total,
    full_total,
    fee,
    rounding,
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
      'platform_fee_min',     ps.fee_min,
      'round_to_rupee',       op.round_to_rupee,
      'extras',               coalesce(op.extras, '[]'::jsonb),
      'cover_sheet',          coalesce(op.cover_sheet, true),
      'cover_price',          coalesce(op.cover_price, 0)
    ),
    cover
  )
  returning id into new_id;

  pg := 0;
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
        (select array_agg(x2::integer)
           from jsonb_array_elements_text(coalesce(item -> 'selected_pages', '[]'::jsonb)) x2),
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

drop function if exists public.reprice_order(uuid, jsonb);
create or replace function public.reprice_order(p_order uuid, p_items jsonb)
returns table (total numeric, platform_fee numeric, rounding numeric, pages integer, colour_pages integer, lines jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  o        public.orders;
  card     public.operators;
  it       record;
  given    jsonb;
  pg       integer;
  cp       integer;
  copies   integer;
  printed  integer := 0;
  bulk     double precision;
  min_ord  numeric;
  subtotal numeric := 0;
  base     numeric;
  fee      numeric;
  tot      numeric;
  rnd      numeric := 0;
  price    numeric;
  out_lines jsonb := '[]'::jsonb;
  pages_t  integer := 0;
  colour_t integer := 0;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null then raise exception 'No such order'; end if;
  if not (o.user_id = public.clerk_id() or public.is_staff(o.operator_id) or public.is_server()) then
    raise exception 'Not your order';
  end if;
  if o.rate_card is null then raise exception 'This order has no rate card to price from'; end if;
  card := jsonb_populate_record(null::public.operators, o.rate_card);

  for it in select oi.* from public.order_items oi where oi.order_id = p_order order by oi.ordinal loop
    given  := (select v from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) v where (v ->> 'item_id')::uuid = it.id limit 1);
    pg     := coalesce((given ->> 'pages')::integer, it.pages);
    cp     := coalesce((given ->> 'colour_pages')::integer, it.colour_pages);
    copies := greatest(coalesce((it.config ->> 'copies')::integer, 1), 1);
    if pg < 1 or pg > 5000 then raise exception 'Page count out of range'; end if;
    if cp < 0 or cp > pg then raise exception 'Colour page count out of range'; end if;
    printed := printed + pg * copies;
  end loop;

  bulk    := case when printed >= coalesce(card.bulk_threshold, 100)
                  then coalesce(card.bulk_multiplier, 0.92)::double precision else 1 end;
  min_ord := public.to_paise(coalesce(card.min_order, 0)::double precision);

  for it in select oi.* from public.order_items oi where oi.order_id = p_order order by oi.ordinal loop
    given := (select v from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) v where (v ->> 'item_id')::uuid = it.id limit 1);
    pg    := coalesce((given ->> 'pages')::integer, it.pages);
    cp    := coalesce((given ->> 'colour_pages')::integer, it.colour_pages);
    price := public.to_paise(public.price_line(pg, cp, it.config, card, bulk));
    subtotal  := subtotal + price;
    pages_t   := pages_t + pg;
    colour_t  := colour_t + cp;
    out_lines := out_lines || jsonb_build_object('item_id', it.id, 'pages', pg, 'colour_pages', cp, 'price', price);
  end loop;

  -- 0044: the cover sheet is on the order already; a correction keeps it.
  subtotal := subtotal + coalesce(o.cover_charge, 0);
  base := greatest(subtotal, min_ord);
  fee  := public.platform_fee_for(base, (o.rate_card ->> 'platform_fee_percent')::numeric, (o.rate_card ->> 'platform_fee_min')::numeric);
  tot  := base + fee;
  if coalesce((o.rate_card ->> 'round_to_rupee')::boolean, false) then
    rnd := ceil(tot) - tot;
    tot := ceil(tot);
  end if;

  return query select tot, fee, rnd, pages_t, colour_t, out_lines;
end;
$$;
grant execute on function public.reprice_order(uuid, jsonb) to authenticated;

-- ============================================================
-- 2. Guards
-- ============================================================
create or replace function public.guard_operator_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
begin
  if new.extras is distinct from old.extras then
    if jsonb_typeof(new.extras) <> 'array' or jsonb_array_length(new.extras) > 12 then
      raise exception 'Up to twelve extras, as a list';
    end if;
    for e in select value from jsonb_array_elements(new.extras) loop
      if jsonb_typeof(e) <> 'object'
         or coalesce(e ->> 'id', '') !~ '^[a-z0-9][a-z0-9-]{0,39}$'
         or length(coalesce(e ->> 'name', '')) not between 1 and 40
         or coalesce(e ->> 'per', '') not in ('copy', 'job')
         or (e ->> 'price') is null
         or (e ->> 'price')::numeric < 0 or (e ->> 'price')::numeric > 5000 then
        raise exception 'Each extra needs a name, a price up to 5000, and per copy or per job';
      end if;
    end loop;
    if (select count(distinct e2 ->> 'id') from jsonb_array_elements(new.extras) e2)
       <> jsonb_array_length(new.extras) then
      raise exception 'Two extras share an id';
    end if;
  end if;

  if new.hours is not null and new.hours is distinct from old.hours then
    if jsonb_typeof(new.hours) <> 'object' then
      raise exception 'Hours are a map of weekday to open/close';
    end if;
    for e in select value from jsonb_each(new.hours) loop
      if jsonb_typeof(e) = 'null' then continue; end if;
      if jsonb_typeof(e) <> 'object'
         or (e ->> 'open') !~ '^[0-2][0-9]:[0-5][0-9]$'
         or (e ->> 'close') !~ '^[0-2][0-9]:[0-5][0-9]$' then
        raise exception 'Each day is open and close as HH:MM, or closed';
      end if;
    end loop;
  end if;

  if public.is_admin() or public.is_server() or public.is_owner(old.id) then
    return new;
  end if;

  if new.name is distinct from old.name or new.campus is distinct from old.campus
     or new.short_name is distinct from old.short_name or new.currency is distinct from old.currency
     or new.bw_per_page is distinct from old.bw_per_page or new.colour_per_page is distinct from old.colour_per_page
     or new.duplex_discount is distinct from old.duplex_discount or new.staple_price is distinct from old.staple_price
     or new.bulk_threshold is distinct from old.bulk_threshold or new.bulk_multiplier is distinct from old.bulk_multiplier
     or new.min_order is distinct from old.min_order or new.paper_gsm is distinct from old.paper_gsm
     or new.pages_per_minute is distinct from old.pages_per_minute or new.handling_minutes is distinct from old.handling_minutes
     or new.is_listed is distinct from old.is_listed
     or new.opens_at is distinct from old.opens_at or new.closes_at is distinct from old.closes_at
     or new.hours is distinct from old.hours or new.closed_on is distinct from old.closed_on or new.tz is distinct from old.tz
     or new.upi_vpa is distinct from old.upi_vpa or new.upi_name is distinct from old.upi_name
     or new.upi_kind is distinct from old.upi_kind or new.upi_mc is distinct from old.upi_mc or new.upi_qr is distinct from old.upi_qr
     or new.accepts_cash is distinct from old.accepts_cash or new.round_to_rupee is distinct from old.round_to_rupee
     or new.shelf_rows is distinct from old.shelf_rows or new.shelf_cols is distinct from old.shelf_cols
     or new.extras is distinct from old.extras
     or new.low_paper_at is distinct from old.low_paper_at or new.low_toner_at is distinct from old.low_toner_at
     or new.max_pages_per_order is distinct from old.max_pages_per_order
     or new.unpaid_expiry_minutes is distinct from old.unpaid_expiry_minutes
     or new.unclaimed_after_hours is distinct from old.unclaimed_after_hours
     or new.gateway_paused is distinct from old.gateway_paused
     or new.cover_sheet is distinct from old.cover_sheet or new.cover_price is distinct from old.cover_price then
    raise exception 'Only the desk''s owner changes rates, payments, hours, extras and staff'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.guard_order_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('printify.gateway', true) = '1' then
    return new;
  end if;

  new.id                := old.id;
  new.user_id           := old.user_id;
  new.operator_id       := old.operator_id;
  new.token             := old.token;
  new.handover_code     := old.handover_code;
  new.created_at        := old.created_at;
  new.rate_card         := old.rate_card;
  new.total             := old.total;
  new.full_colour_total := old.full_colour_total;
  new.platform_fee      := old.platform_fee;
  new.rounding          := old.rounding;
  new.pages             := old.pages;
  new.colour_pages      := old.colour_pages;
  new.config            := old.config;
  new.requote           := old.requote;
  new.requote_status    := old.requote_status;
  new.gateway_order_id   := old.gateway_order_id;
  new.gateway_payment_id := old.gateway_payment_id;
  new.gateway_paid_at    := old.gateway_paid_at;
  new.fee_settled_at     := old.fee_settled_at;
  new.gateway_refund_id  := old.gateway_refund_id;
  new.gateway_split      := old.gateway_split;
  new.pay_at_pickup      := old.pay_at_pickup;
  new.print_on_signal    := old.print_on_signal;
  new.signalled_at       := old.signalled_at;
  new.covered_at         := old.covered_at;
  new.covered_amount     := old.covered_amount;
  new.reminded_at        := old.reminded_at;
  new.cover_charge       := old.cover_charge;

  if public.is_staff(old.operator_id) then
    new.payment_method         := old.payment_method;
    new.payment_claimed_at     := old.payment_claimed_at;
    new.payment_claimed_amount := old.payment_claimed_amount;
    new.payment_reference      := old.payment_reference;
    -- A correction is waiting on the student: the desk withdraws it or waits.
    if old.requote_status = 'proposed' and new.status is distinct from old.status and new.status <> 'cancelled' then
      raise exception 'The corrected bill is waiting for the student — withdraw it to go ahead at the original price';
    end if;
    if (new.refunded_at is distinct from old.refunded_at
        or new.refund_amount is distinct from old.refund_amount
        or new.refund_note is distinct from old.refund_note)
       and not (public.is_owner(old.operator_id) or public.is_admin()) then
      raise exception 'Only the desk''s owner records a refund';
    end if;
    -- Queued means paid — except a cash-at-pickup order, which the desk
    -- printed on the student's credit and is paid at the handover.
    if new.status = 'queued' and old.status <> 'queued' and not old.pay_at_pickup then
      new.payment_taken_at := coalesce(new.payment_taken_at, now());
      new.payment_received := coalesce(new.payment_received, new.total);
    end if;
    if new.status = 'collected' and old.status <> 'collected' and old.pay_at_pickup and old.payment_taken_at is null then
      new.payment_taken_at := coalesce(new.payment_taken_at, now());
      new.payment_received := coalesce(new.payment_received, new.total);
    end if;
    if new.payment_received is not null
       and (new.payment_received < 0 or new.payment_received > 100000) then
      raise exception 'The amount received is out of range';
    end if;
    if new.refund_amount is not null
       and (new.refund_amount < 0 or new.refund_amount > new.total) then
      raise exception 'A refund is between nothing and the bill';
    end if;
    return new;
  end if;

  new.queued_at         := old.queued_at;
  new.pickup_mode       := old.pickup_mode;
  new.pickup_at         := old.pickup_at;
  new.is_priority       := old.is_priority;
  new.operator_note     := old.operator_note;
  new.payment_taken_at  := old.payment_taken_at;
  new.payment_received  := old.payment_received;
  new.shortfall_cleared_at := old.shortfall_cleared_at;
  new.shelf_slot        := old.shelf_slot;
  new.accepted_at       := old.accepted_at;
  new.started_at        := old.started_at;
  new.ready_at          := old.ready_at;
  new.collected_at      := old.collected_at;
  new.refunded_at       := old.refunded_at;
  new.refund_amount     := old.refund_amount;
  new.refund_note       := old.refund_note;
  new.cancelled_by      := old.cancelled_by;

  if old.payment_taken_at is not null then
    new.payment_method         := old.payment_method;
    new.payment_reference      := old.payment_reference;
    new.payment_claimed_amount := old.payment_claimed_amount;
    new.payment_claimed_at     := old.payment_claimed_at;
  end if;
  if new.payment_method = 'gateway' and old.payment_method is distinct from 'gateway' then
    raise exception 'A payment through Printifi is recorded by Printifi';
  end if;
  -- Cash is chosen through choose_cash(), which checks the student's standing.
  if new.payment_method = 'cash' and old.payment_method is distinct from 'cash' then
    raise exception 'Cash is chosen from the pay sheet';
  end if;
  -- A corrected bill waits for a yes before any money is claimed against it.
  if old.requote_status = 'proposed' and new.payment_claimed_at is not null and old.payment_claimed_at is null then
    raise exception 'The desk corrected this bill — accept the new price first';
  end if;
  if new.payment_claimed_amount is not null
     and (new.payment_claimed_amount < 0 or new.payment_claimed_amount > 100000) then
    raise exception 'That amount is out of range';
  end if;

  if new.status is distinct from old.status then
    if new.status <> 'cancelled' then
      raise exception 'You can only cancel this order';
    end if;
    if old.status not in ('placed', 'queued') then
      raise exception 'Too late to cancel — the desk has started on it. Ask at the counter.';
    end if;
    new.cancelled_by := 'student';
  end if;

  return new;
end;
$$;

-- ============================================================
-- 3. The slot, assigned when the job joins the queue
-- ============================================================
create or replace function public.assign_shelf_slot()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rows_n integer;
  cols_n integer;
  free   text;
begin
  -- Into the queue (0044) or into ready (0030): whichever comes first
  -- without a slot named. A job that found every slot taken at queue time
  -- tries again when it's ready.
  if new.status not in ('queued', 'ready') or new.status = old.status or new.shelf_slot is not null then
    return new;
  end if;
  select o.shelf_rows, o.shelf_cols into rows_n, cols_n
    from public.operators o where o.id = new.operator_id;
  if coalesce(rows_n, 0) = 0 then
    return new;
  end if;
  select s.slot into free
    from (select chr(64 + r) || c::text as slot, r, c
            from generate_series(1, rows_n) r, generate_series(1, cols_n) c) s
   where not exists (
           select 1 from public.orders q
            where q.operator_id = new.operator_id
              and q.status in ('queued', 'printing', 'finishing', 'ready')
              and q.shelf_slot = s.slot
              and q.id <> new.id)
   order by s.r, s.c
   limit 1;
  -- Every slot taken: the job goes on without one; the card says so and
  -- the desk can type one when a packet leaves.
  new.shelf_slot := free;
  return new;
end;
$$;

commit;
