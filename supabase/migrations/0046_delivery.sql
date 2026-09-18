-- 0046: delivery to the door, by Printifi's own runner.
--
-- Run after 0045 (which adds the 'delivering' status on its own).
--
-- A student can have the job brought to their hostel room instead of
-- walking to the desk. The desk prints and files it as always; a runner —
-- an account the admin has granted, never a self-appointed one — picks
-- it up from the shelf, carries it, and hands it over at the door against
-- the same code the counter would ask for. The desk is paid its price for
-- the job whatever way the student paid; the delivery fee is Printifi's.
--
--   platform_settings.delivery_*     the switch, the fee (₹10 by default),
--                                    the hostels served, and a line the
--                                    student reads (round times) — the
--                                    admin's
--   operators.delivery               which desks the runner collects from —
--                                    the admin's, like online payment
--   runners                          who may carry: requested → active →
--                                    removed, written only by the functions
--   orders.delivery / delivery_fee / deliver_to / runner_id / picked_up_at /
--   delivered_at / returned_at / delivery_returns / delivery_proof
--                                    the order's own record of it
--
-- The money, by how the student paid:
--   through Printifi   Printifi holds the bill; the desk's share is the bill
--                      less the platform fee less the delivery fee (desk_share)
--   cash at the door   the runner holds it; the desk is credited its price
--                      (bill less fee less delivery fee) — a desk_credits row
--                      'delivery_cash' — and the platform fee counts as
--                      retained, since Printifi has the cash
--   UPI to the desk    the desk holds the bill, delivery fee included; it
--                      owes Printifi the fee — a 'delivery_fee' row, negative
-- A delivery order the student collects at the desk themselves keeps its
-- bill as placed: the desk took the money, the desk keeps it.
--
-- What a runner can do is exactly: read the delivery orders that are ready
-- or in their hands (name, phone, hostel, room, what's owed — never the
-- handover secret), mark one picked up, delivered (with or without the
-- student's code, and the row says which), or returned to the desk with a
-- reason. Nothing else — not a desk's queue, not another order, not /admin.

begin;

-- ============================================================
-- 1. Columns and tables
-- ============================================================
alter table public.platform_settings
  add column if not exists delivery_enabled boolean       not null default false,
  add column if not exists delivery_fee     numeric(10,2) not null default 10 check (delivery_fee >= 0 and delivery_fee <= 200),
  add column if not exists delivery_areas   text[]        not null default '{}',
  add column if not exists delivery_note    text;

alter table public.operators
  add column if not exists delivery boolean not null default false;

alter table public.orders
  add column if not exists delivery         boolean       not null default false,
  add column if not exists delivery_fee     numeric(10,2) not null default 0 check (delivery_fee >= 0),
  add column if not exists deliver_to       jsonb,
  add column if not exists runner_id        text,
  add column if not exists picked_up_at     timestamptz,
  add column if not exists delivered_at     timestamptz,
  add column if not exists returned_at      timestamptz,
  add column if not exists delivery_returns integer       not null default 0,
  add column if not exists delivery_proof   text;
alter table public.orders drop constraint if exists orders_delivery_proof_valid;
alter table public.orders add constraint orders_delivery_proof_valid
  check (delivery_proof is null or delivery_proof in ('scan', 'runner'));
create index if not exists orders_delivery_live on public.orders (status, ready_at) where delivery;

-- Two more kinds of credit between Printifi and a desk (see the header).
alter table public.desk_credits drop constraint if exists desk_credits_kind_check;
alter table public.desk_credits add constraint desk_credits_kind_check
  check (kind in ('unclaimed', 'dues_cash', 'delivery_cash', 'delivery_fee'));

create table if not exists public.runners (
  user_id      text primary key,
  status       text not null default 'requested' check (status in ('requested', 'active', 'removed')),
  phone        text,
  requested_at timestamptz not null default now(),
  approved_by  text,
  approved_at  timestamptz,
  removed_at   timestamptz
);
alter table public.runners enable row level security;
drop policy if exists "runners own read" on public.runners;
create policy "runners own read" on public.runners for select
  using (user_id = public.clerk_id() or public.is_admin());
-- Writes go through the functions below only.

/** Is the caller an active runner? Read inside definer bodies. */
create or replace function public.is_runner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.runners r where r.user_id = public.clerk_id() and r.status = 'active')
$$;

-- ============================================================
-- 2. Pricing: the delivery fee is a line, after the desk's bill
-- ============================================================
-- The signature grows a fourth argument, so the old one is dropped first:
-- two overloads with defaults would leave PostgREST unable to choose.
drop function if exists public.place_order(uuid, jsonb, timestamptz);
create or replace function public.place_order(
  p_operator  uuid,
  p_items     jsonb,
  p_pickup_at timestamptz default null,
  p_delivery  jsonb default null
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
  dfee         numeric := 0;
  hostel       text;
  room         text;
  ph           text;
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

  -- 0046: delivery. Only where the platform and this desk offer it, only
  -- to a hostel on the list (when there is one), and only with a room and
  -- a phone the runner can use. The fee is the platform's, taken as it
  -- stands today.
  if p_delivery is not null and jsonb_typeof(p_delivery) = 'object' then
    if not coalesce(ps.delivery_enabled, false) then
      raise exception 'Delivery isn''t on right now — collect at the desk';
    end if;
    if not coalesce(op.delivery, false) then
      raise exception 'This desk doesn''t deliver yet — collect at the counter';
    end if;
    if p_pickup_at is not null then
      raise exception 'A delivery goes out on the next round — a pickup time doesn''t apply';
    end if;
    hostel := nullif(trim(coalesce(p_delivery ->> 'hostel', '')), '');
    room   := nullif(trim(coalesce(p_delivery ->> 'room', '')), '');
    if hostel is null or length(hostel) > 60 then raise exception 'Which hostel should it come to?'; end if;
    if room is null or length(room) > 20 then raise exception 'Which room should it come to?'; end if;
    if coalesce(array_length(ps.delivery_areas, 1), 0) > 0 and not (hostel = any (ps.delivery_areas)) then
      raise exception 'Printifi doesn''t deliver to % yet — collect at the desk', hostel;
    end if;
    select p.phone into ph from public.profiles p where p.id = me;
    if ph is null or length(trim(ph)) < 8 then
      raise exception 'Add your phone number in Settings so the runner can reach you at the door';
    end if;
    dfee := public.to_paise(coalesce(ps.delivery_fee, 0)::double precision);
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
  -- 0046: the delivery fee sits after the desk's bill — outside the
  -- minimum, the platform fee and the rounding, which are all the desk's
  -- arithmetic. quoteOrder() adds it in the same place.
  total      := total + dfee;
  full_total := full_total + dfee;

  insert into public.orders (
    user_id, operator_id, total, full_colour_total, platform_fee, rounding, pages, colour_pages, config,
    pickup_mode, pickup_at, rate_card, cover_charge,
    delivery, delivery_fee, deliver_to
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
    cover,
    dfee > 0 or hostel is not null,
    dfee,
    case when hostel is not null then jsonb_build_object('hostel', hostel, 'room', room) else null end
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
grant execute on function public.place_order(uuid, jsonb, timestamptz, jsonb) to authenticated;

-- A correction keeps the delivery fee exactly as it keeps the cover.
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
  -- 0046: and the delivery fee, after everything the desk's card decides.
  tot := tot + coalesce(o.delivery_fee, 0);

  return query select tot, fee, rnd, pages_t, colour_t, out_lines;
end;
$$;
grant execute on function public.reprice_order(uuid, jsonb) to authenticated;

-- ============================================================
-- 3. Guards: the new columns are the platform's; a desk's delivery switch is the admin's
-- ============================================================
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
  -- 0046: the delivery is decided at placing; what happens to it after is
  -- the runner's, through the functions, never a row edit.
  new.delivery           := old.delivery;
  new.delivery_fee       := old.delivery_fee;
  new.deliver_to         := old.deliver_to;
  new.runner_id          := old.runner_id;
  new.picked_up_at       := old.picked_up_at;
  new.delivered_at       := old.delivered_at;
  new.returned_at        := old.returned_at;
  new.delivery_returns   := old.delivery_returns;
  new.delivery_proof     := old.delivery_proof;

  if public.is_staff(old.operator_id) then
    new.payment_method         := old.payment_method;
    new.payment_claimed_at     := old.payment_claimed_at;
    new.payment_claimed_amount := old.payment_claimed_amount;
    new.payment_reference      := old.payment_reference;
    -- A correction is waiting on the student: the desk withdraws it or waits.
    if old.requote_status = 'proposed' and new.status is distinct from old.status and new.status <> 'cancelled' then
      raise exception 'The corrected bill is waiting for the student — withdraw it to go ahead at the original price';
    end if;
    -- 0046: a job in the runner's hands isn't the desk's to move; it comes
    -- back through the runner (returned) or ends at the door (delivered).
    if old.status = 'delivering' and new.status is distinct from old.status then
      raise exception 'This job is with Printifi''s runner — it comes back to you if it can''t be delivered';
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

-- Which desks the runner collects from is Printifi's call, like online
-- payment: a desk the runner never visits mustn't offer delivery.
create or replace function public.guard_operator_shut()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Not the desk's to change: who it is, when it was made.
  new.id         := old.id;
  new.created_at := old.created_at;

  if (new.shut_at     is distinct from old.shut_at
   or new.shut_reason is distinct from old.shut_reason
   or new.shut_by     is distinct from old.shut_by)
     and not public.is_admin() then
    raise exception 'Only the admin shuts or restores a desk' using errcode = 'check_violation';
  end if;
  if (new.gateway_vendor_id  is distinct from old.gateway_vendor_id
   or new.gateway_status     is distinct from old.gateway_status
   or new.gateway_checked_at is distinct from old.gateway_checked_at)
     and not (public.is_admin() or public.is_server()) then
    raise exception 'Only Printifi switches online payment for a desk' using errcode = 'check_violation';
  end if;
  if new.delivery is distinct from old.delivery and not (public.is_admin() or public.is_server()) then
    raise exception 'Only Printifi switches delivery for a desk' using errcode = 'check_violation';
  end if;
  if new.shut_at is not null and not public.is_admin() then
    if new.is_open and not old.is_open then
      raise exception 'This desk was closed by Printifi: %', old.shut_reason
        using errcode = 'check_violation';
    end if;
    if new.is_listed and not old.is_listed then
      raise exception 'This desk was closed by Printifi and cannot be listed'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

-- ============================================================
-- 4. The money: the desk's share, the credits, the stamps
-- ============================================================
-- A desk's share of an online, unsplit order: the bill less the platform
-- fee less the delivery fee — neither was ever the desk's — scaled by what
-- wasn't refunded.
create or replace function public.desk_share(o public.orders)
returns numeric language sql immutable as $$
  select case
           when o.gateway_paid_at is null or o.gateway_split or o.status in ('cancelled', 'failed') then 0
           when o.total <= 0 then 0
           else round((o.total - coalesce(o.platform_fee, 0) - coalesce(o.delivery_fee, 0))
                      * (1 - least(coalesce(o.refund_amount, 0), o.total) / o.total), 2)
         end
$$;

/**
 * Before an order's row changes (0043, extended for 0046):
 *   * a cash order handed over — at the counter or at the door — is stamped
 *     paid and grows the student's limit;
 *   * a delivery the runner completed settles who holds what: cash at the
 *     door is Printifi's, so the desk is credited its price and the fee
 *     counts as retained; a bill paid to the desk directly carried
 *     Printifi's delivery fee, so the desk owes that back;
 *   * an unclaimed, unpaid cash order becomes dues, a strike, and a credit
 *     to the desk of its price — the delivery fee, if any, isn't the desk's.
 * Runs ahead of the guard (alphabetically), and marks the transaction as
 * the platform's own only for its own writes.
 */
create or replace function public.settle_cash_ending()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s    public.platform_settings;
  op   public.operators;
  strikes integer;
  share   numeric;
  was   text := coalesce(current_setting('printify.gateway', true), '');
begin
  if new.status is not distinct from old.status then return new; end if;

  -- Handed over: the cash changed hands, and the student earned a step.
  -- The profile write carries the platform's flag for its own duration
  -- only, so the order guard still runs for the desk's update as usual.
  if new.status = 'collected' and new.pay_at_pickup and new.payment_taken_at is null and new.gateway_paid_at is null then
    new.payment_taken_at := now();
    new.payment_received := coalesce(new.payment_received, new.total);
    perform set_config('printify.gateway', '1', true);
    update public.profiles set cash_collected = cash_collected + 1 where id = new.user_id;
    perform set_config('printify.gateway', was, true);
  end if;

  -- Delivered by the runner (runner_deliver stamps delivered_at in the same
  -- write): where the money is. A delivery order the student collected at
  -- the desk instead doesn't come here — the desk took the money and keeps it.
  if new.status = 'collected' and old.status <> 'collected'
     and coalesce(new.delivery, false) and new.delivered_at is not null and old.delivered_at is null then
    select * into op from public.operators where id = new.operator_id;
    if new.pay_at_pickup and new.gateway_paid_at is null then
      -- Cash at the door, in the runner's hand: Printifi holds the bill, so
      -- the platform fee is retained and the desk is owed its price.
      new.fee_settled_at := coalesce(new.fee_settled_at, now());
      share := greatest(round(new.total - coalesce(new.platform_fee, 0) - coalesce(new.delivery_fee, 0), 2), 0);
      if share > 0 then
        insert into public.desk_credits (operator_id, order_id, user_id, amount, kind, applied_to, note)
        values (new.operator_id, new.id, new.user_id, share, 'delivery_cash',
                case when op.gateway_status = 'collect' then 'payout' else 'fee' end,
                'Order ' || coalesce(new.token, '') || ' delivered by Printifi — cash taken at the door, your price credited');
      end if;
    elsif new.gateway_paid_at is null and new.payment_taken_at is not null and coalesce(new.delivery_fee, 0) > 0 then
      -- Paid to the desk directly, delivery fee included: that part is Printifi's.
      insert into public.desk_credits (operator_id, order_id, user_id, amount, kind, applied_to, note)
      values (new.operator_id, new.id, new.user_id, -new.delivery_fee, 'delivery_fee',
              case when op.gateway_status = 'collect' then 'payout' else 'fee' end,
              'Order ' || coalesce(new.token, '') || ' delivered by Printifi — the delivery fee you were paid');
    end if;
    return new;
  end if;

  -- Unclaimed: only the platform marks it (the sweep, flagged), and only
  -- then do the consequences follow — a stray write can't fine anyone.
  if new.status = 'unclaimed' and new.pay_at_pickup
     and new.payment_taken_at is null and new.gateway_paid_at is null
     and new.covered_at is null
     and was = '1' then
    select * into s from public.platform_settings where id;
    select * into op from public.operators where id = new.operator_id;

    update public.profiles
       set dues = dues + new.total,
           cash_strikes = cash_strikes + 1
     where id = new.user_id
     returning cash_strikes into strikes;
    if strikes >= s.cash_strikes_allowed then
      update public.profiles
         set cash_blocked_until = now() + make_interval(days => s.cash_lockout_days)
       where id = new.user_id;
    end if;

    new.covered_amount := greatest(round(new.total - coalesce(new.platform_fee, 0) - coalesce(new.delivery_fee, 0), 2), 0);
    new.covered_at     := now();
    if new.covered_amount > 0 then
      insert into public.desk_credits (operator_id, order_id, user_id, amount, kind, applied_to, note)
      values (new.operator_id, new.id, new.user_id, new.covered_amount, 'unclaimed',
              case when op.gateway_status = 'collect' then 'payout' else 'fee' end,
              'Uncollected cash order ' || coalesce(new.token, '') || ' — covered by Printifi');
    end if;
  end if;
  return new;
end;
$$;

-- ============================================================
-- 5. Cash for a delivery: at the door, on the next round
-- ============================================================
-- A job in the runner's hands is still an open cash order.
drop function if exists public.cash_standing(text);
create or replace function public.cash_standing(p_user text default null)
returns table (
  dues numeric, cash_limit numeric, strikes integer, collected integer,
  blocked_until timestamptz, open_cash_order uuid, open_cash_token text,
  can_cash boolean, reason text
)
language plpgsql stable security definer set search_path = public as $$
declare
  who   text := coalesce(p_user, public.clerk_id());
  prof  public.profiles;
  lim   numeric;
  open_id uuid;
  open_tok text;
begin
  if who is null then return; end if;
  if who <> coalesce(public.clerk_id(), '') and not public.is_admin() and not public.is_server()
     and not exists (select 1 from public.staff s where s.user_id = public.clerk_id()) then
    return;
  end if;
  select * into prof from public.profiles where id = who;
  lim := public.cash_limit_of(who);
  select o.id, o.token into open_id, open_tok
    from public.orders o
   where o.user_id = who and o.pay_at_pickup and o.payment_taken_at is null and o.gateway_paid_at is null
     and o.status in ('placed', 'queued', 'printing', 'finishing', 'ready', 'delivering')
   order by o.created_at limit 1;
  return query select
    coalesce(prof.dues, 0)::numeric,
    lim,
    coalesce(prof.cash_strikes, 0),
    coalesce(prof.cash_collected, 0),
    prof.cash_blocked_until,
    open_id,
    open_tok,
    coalesce(prof.dues, 0) = 0
      and (prof.cash_blocked_until is null or prof.cash_blocked_until < now())
      and open_id is null,
    case
      when coalesce(prof.dues, 0) > 0 then 'dues'
      when prof.cash_blocked_until is not null and prof.cash_blocked_until >= now() then 'blocked'
      when open_id is not null then 'open'
      else null
    end;
end;
$$;
grant execute on function public.cash_standing(text) to authenticated;

/**
 * The student chooses cash for an order. Within their limit the order goes
 * straight into the queue and is paid when collected; above it, the desk
 * waits for "Leaving now" before printing. A delivery (0046) has no
 * "leaving now" — the runner is the one who sets off — so it queues at
 * once whatever the limit: Printifi's own person is at the door for the
 * cash, the desk is covered if it's never taken, and an order not taken
 * becomes dues and a strike like any other. Returns 'queued' or 'signal'.
 */
create or replace function public.choose_cash(p_order uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  o    public.orders;
  op   public.operators;
  st   record;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null or o.user_id <> coalesce(public.clerk_id(), '') then
    raise exception 'Not your order';
  end if;
  if o.status <> 'placed' then raise exception 'This order isn''t waiting for payment'; end if;
  if o.gateway_paid_at is not null or o.payment_taken_at is not null then raise exception 'This order is already paid'; end if;
  if o.requote_status = 'proposed' then raise exception 'The desk corrected this bill — accept the new price first'; end if;
  select * into op from public.operators where id = o.operator_id;
  if op.accepts_cash = false then raise exception 'This desk doesn''t take cash'; end if;

  select * into st from public.cash_standing(o.user_id);
  if st.dues > 0 then
    raise exception 'You have ₹% due from an uncollected order. Pay it to order again.', trim(to_char(st.dues, 'FM999999990.00'));
  end if;
  if st.blocked_until is not null and st.blocked_until >= now() then
    raise exception 'Cash is off for your account until % — pay online for now.', to_char(st.blocked_until at time zone coalesce(op.tz, 'Asia/Kolkata'), 'DD Mon');
  end if;
  if st.open_cash_order is not null and st.open_cash_order <> o.id then
    raise exception 'Collect your other cash order (%) first — one at a time.', coalesce(st.open_cash_token, '');
  end if;

  perform set_config('printify.gateway', '1', true);
  if coalesce(o.delivery, false) then
    update public.orders
       set payment_method = 'cash', payment_claimed_at = now(), pay_at_pickup = true,
           print_on_signal = false, note = 'Cash at the door when it''s delivered', status = 'queued'
     where id = o.id;
    return 'queued';
  end if;
  if o.total <= st.cash_limit then
    -- The note rides on the 'queued' event, which is how the message that
    -- goes out knows to say what's owed at the counter.
    update public.orders
       set payment_method = 'cash', payment_claimed_at = now(), pay_at_pickup = true,
           print_on_signal = false, note = 'Cash at the counter when you collect', status = 'queued'
     where id = o.id;
    return 'queued';
  end if;
  update public.orders
     set payment_method = 'cash', payment_claimed_at = now(), pay_at_pickup = true,
         print_on_signal = true, note = 'Cash at the counter when you collect'
   where id = o.id;
  return 'signal';
end;
$$;

-- ============================================================
-- 6. The runner
-- ============================================================
/** Asking to deliver for Printifi. Anyone signed in; nothing opens until the admin says yes. */
create or replace function public.request_runner(p_phone text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  me   text := public.clerk_id();
  r    public.runners;
  who  text;
begin
  if me is null then raise exception 'Sign in first'; end if;
  select * into r from public.runners where user_id = me;
  if r.status = 'active' then return 'active'; end if;
  if p_phone is not null and length(trim(p_phone)) > 0 and length(trim(p_phone)) < 8 then
    raise exception 'A phone number the admin can reach you on';
  end if;
  insert into public.runners (user_id, status, phone, requested_at, removed_at)
  values (me, 'requested', nullif(trim(coalesce(p_phone, '')), ''), now(), null)
  on conflict (user_id) do update
    set status = 'requested', phone = coalesce(excluded.phone, runners.phone), requested_at = now(), removed_at = null;
  -- A word to the admin, on a desk device.
  select coalesce(p.name, p.email, me) into who from public.profiles p where p.id = me;
  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail, audience)
  select a.user_id, null, 'push', null, 'Runner request from ' || coalesce(who, me) || ' — approve it under Runners in Admin.', 'queued', null, 'desk'
    from public.admins a
   where exists (select 1 from public.push_subscriptions ps where ps.user_id = a.user_id and ps.desk);
  return 'requested';
end;
$$;

/** Every runner and request, for the admin. */
drop function if exists public.admin_runners();
create or replace function public.admin_runners()
returns table (
  user_id text, name text, email text, phone text, status text,
  requested_at timestamptz, approved_at timestamptz, removed_at timestamptz,
  delivered integer, carrying integer
)
language sql stable security definer set search_path = public as $$
  select r.user_id, p.name, p.email, coalesce(r.phone, p.phone), r.status,
         r.requested_at, r.approved_at, r.removed_at,
         (select count(*)::integer from public.orders o where o.runner_id = r.user_id and o.status = 'collected'),
         (select count(*)::integer from public.orders o where o.runner_id = r.user_id and o.status = 'delivering')
    from public.runners r
    left join public.profiles p on p.id = r.user_id
   where public.is_admin()
   order by case r.status when 'requested' then 0 when 'active' then 1 else 2 end, r.requested_at desc
$$;

/**
 * Approve or remove a runner. Removing one puts whatever they were carrying
 * back on the desk's shelf as ready — the student is told to collect it
 * there, and the next runner can take it out again.
 */
create or replace function public.admin_set_runner(p_user text, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  o public.orders;
begin
  if not public.is_admin() then raise exception 'Only the admin grants runners'; end if;
  if not exists (select 1 from public.runners r where r.user_id = p_user) then
    raise exception 'No such runner';
  end if;
  if p_active then
    update public.runners
       set status = 'active', approved_by = public.clerk_id(), approved_at = now(), removed_at = null
     where user_id = p_user;
    perform public.notify_student(p_user, null, 'You''re a Printifi runner now. Open Printifi Desk — Deliveries is where the jobs are.');
    return;
  end if;
  update public.runners set status = 'removed', removed_at = now() where user_id = p_user;
  perform set_config('printify.gateway', '1', true);
  for o in
    select * from public.orders x where x.runner_id = p_user and x.status = 'delivering' for update
  loop
    update public.orders
       set status = 'ready', runner_id = null, picked_up_at = null, returned_at = now(), ready_at = now(),
           delivery_returns = delivery_returns + 1,
           note = 'Back at the desk — collect it there, or it goes out on the next round'
     where id = o.id;
  end loop;
end;
$$;

/** The admin grants a runner by email — themselves, to start with. The account must have signed in once. */
create or replace function public.admin_add_runner(p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare
  who text;
begin
  if not public.is_admin() then raise exception 'Only the admin grants runners'; end if;
  select p.id into who from public.profiles p where lower(p.email) = lower(trim(coalesce(p_email, ''))) order by p.created_at limit 1;
  if who is null then raise exception 'No account with that email has signed in to Printifi yet'; end if;
  insert into public.runners (user_id, status, approved_by, approved_at)
  values (who, 'active', public.clerk_id(), now())
  on conflict (user_id) do update
    set status = 'active', approved_by = excluded.approved_by, approved_at = now(), removed_at = null;
  return who;
end;
$$;

/**
 * The runner's list: delivery orders waiting on a shelf, the ones in this
 * runner's hands (or another's, named as such), and this runner's last
 * day of deliveries. The student's name, phone and room — what it takes to
 * find them — and what's owed in cash. Never the handover secret: that
 * stays on the student's screen, and runner_deliver checks it.
 */
drop function if exists public.runner_orders();
create or replace function public.runner_orders()
returns table (
  id uuid, token text, status text, operator_id uuid, desk text, campus text,
  student text, phone text, hostel text, room text,
  pages integer, total numeric, cash_due numeric, delivery_fee numeric,
  ready_at timestamptz, picked_up_at timestamptz, delivered_at timestamptz, returned_at timestamptz,
  delivery_returns integer, runner_id text, mine boolean, shelf_slot text, note text, delivery_proof text
)
language sql stable security definer set search_path = public as $$
  select o.id, o.token, o.status::text, o.operator_id, coalesce(nullif(op.short_name, ''), op.name), op.campus,
         p.name, p.phone, o.deliver_to ->> 'hostel', o.deliver_to ->> 'room',
         o.pages, o.total,
         case when o.pay_at_pickup and o.payment_taken_at is null and o.gateway_paid_at is null then o.total else 0 end,
         o.delivery_fee,
         o.ready_at, o.picked_up_at, o.delivered_at, o.returned_at,
         o.delivery_returns, o.runner_id, coalesce(o.runner_id = public.clerk_id(), false), o.shelf_slot, o.note, o.delivery_proof
    from public.orders o
    join public.operators op on op.id = o.operator_id
    left join public.profiles p on p.id = o.user_id
   where (public.is_runner() or public.is_admin())
     and o.delivery
     and (o.status in ('ready', 'delivering')
          or (o.status = 'collected' and o.runner_id = public.clerk_id() and o.delivered_at >= now() - interval '1 day'))
   order by case o.status::text when 'delivering' then 0 when 'ready' then 1 else 2 end, o.ready_at
$$;

/** Off the shelf and into the runner's bag. */
create or replace function public.runner_pickup(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  o  public.orders;
  me text := public.clerk_id();
begin
  if not public.is_runner() then raise exception 'You''re not a runner on Printifi'; end if;
  select * into o from public.orders where id = p_order for update;
  if o.id is null or not coalesce(o.delivery, false) then raise exception 'That isn''t a delivery order'; end if;
  if o.status = 'delivering' then
    if o.runner_id = me then return; end if;
    raise exception 'Another runner has this one';
  end if;
  if o.status <> 'ready' then raise exception 'This job isn''t on the shelf yet'; end if;
  perform set_config('printify.gateway', '1', true);
  update public.orders
     set status = 'delivering', runner_id = me, picked_up_at = now(),
         note = 'Picked up by Printifi''s runner'
   where id = o.id;
end;
$$;

/**
 * Handed over at the door. With the student's code (their QR, scanned) the
 * row says 'scan'; without it, 'runner' — the runner's word, as a counter
 * handover tapped without a scan is the desk's. A wrong code is refused,
 * not recorded.
 */
create or replace function public.runner_deliver(p_order uuid, p_code text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  o  public.orders;
  me text := public.clerk_id();
begin
  if not public.is_runner() then raise exception 'You''re not a runner on Printifi'; end if;
  select * into o from public.orders where id = p_order for update;
  if o.id is null or o.status <> 'delivering' or o.runner_id is distinct from me then
    raise exception 'This job isn''t in your hands';
  end if;
  if nullif(trim(coalesce(p_code, '')), '') is not null
     and upper(trim(p_code)) <> upper(coalesce(o.handover_code, '')) then
    raise exception 'That code isn''t this order''s — check the token on the student''s screen';
  end if;
  perform set_config('printify.gateway', '1', true);
  update public.orders
     set status = 'collected', collected_at = now(), delivered_at = now(),
         delivery_proof = case when nullif(trim(coalesce(p_code, '')), '') is null then 'runner' else 'scan' end,
         note = case when nullif(trim(coalesce(p_code, '')), '') is null
                     then 'Delivered by Printifi''s runner'
                     else 'Delivered — the student''s code was scanned at the door' end
   where id = o.id;
end;
$$;

/** Couldn't be delivered: back on the desk's shelf, ready, with the reason. The next round can try again. */
create or replace function public.runner_return(p_order uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  o  public.orders;
  me text := public.clerk_id();
  why text := trim(coalesce(p_reason, ''));
begin
  if not public.is_runner() then raise exception 'You''re not a runner on Printifi'; end if;
  select * into o from public.orders where id = p_order for update;
  if o.id is null or o.status <> 'delivering' or o.runner_id is distinct from me then
    raise exception 'This job isn''t in your hands';
  end if;
  if length(why) not between 2 and 140 then raise exception 'Say why, briefly'; end if;
  perform set_config('printify.gateway', '1', true);
  update public.orders
     set status = 'ready', runner_id = null, picked_up_at = null, returned_at = now(), ready_at = now(),
         delivery_returns = delivery_returns + 1,
         note = 'Couldn''t deliver: ' || why || ' — back at the desk'
   where id = o.id;
end;
$$;

-- ============================================================
-- 7. The admin's switches and numbers
-- ============================================================
create or replace function public.set_delivery_policy(p_enabled boolean, p_fee numeric, p_areas text[], p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  clean text[];
begin
  if not public.is_admin() then raise exception 'Only the admin sets delivery'; end if;
  if p_fee is null or p_fee < 0 or p_fee > 200 then raise exception 'The delivery fee is 0 to 200'; end if;
  select coalesce(array_agg(distinct trim(a) order by trim(a)), '{}')
    into clean
    from unnest(coalesce(p_areas, '{}'::text[])) a
   where length(trim(a)) between 1 and 60;
  if coalesce(array_length(clean, 1), 0) > 60 then raise exception 'Up to sixty hostels'; end if;
  update public.platform_settings
     set delivery_enabled = coalesce(p_enabled, false),
         delivery_fee = round(p_fee, 2),
         delivery_areas = clean,
         delivery_note = nullif(left(trim(coalesce(p_note, '')), 200), ''),
         updated_by = public.clerk_id(), updated_at = now()
   where id;
end;
$$;

/** Which desks the runner collects from. The admin's, like online payment. */
create or replace function public.set_desk_delivery(p_operator uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the admin switches delivery for a desk'; end if;
  update public.operators set delivery = coalesce(p_on, false) where id = p_operator;
  if not found then raise exception 'No such desk'; end if;
end;
$$;

drop function if exists public.admin_delivery_report();
create or replace function public.admin_delivery_report()
returns table (
  delivered integer, in_flight integer, waiting integer, returned integer,
  fees_earned numeric, cash_in_hand numeric, fees_owed_by_desks numeric,
  active_runners integer, requests integer
)
language sql stable security definer set search_path = public as $$
  select * from (
    select (select count(*)::integer from public.orders o where o.delivery and o.status = 'collected' and o.delivered_at is not null),
           (select count(*)::integer from public.orders o where o.status = 'delivering'),
           (select count(*)::integer from public.orders o where o.delivery and o.status = 'ready'),
           (select coalesce(sum(o.delivery_returns), 0)::integer from public.orders o where o.delivery),
           (select coalesce(sum(o.delivery_fee), 0)::numeric from public.orders o where o.delivery and o.status = 'collected' and o.delivered_at is not null),
           (select coalesce(sum(o.total), 0)::numeric from public.orders o
             where o.delivery and o.status = 'collected' and o.delivered_at is not null
               and o.pay_at_pickup and o.gateway_paid_at is null),
           (select coalesce(-sum(d.amount), 0)::numeric from public.desk_credits d where d.kind = 'delivery_fee'),
           (select count(*)::integer from public.runners r where r.status = 'active'),
           (select count(*)::integer from public.runners r where r.status = 'requested')
  ) r
  where public.is_admin();
$$;

-- ============================================================
-- 8. The sweep leaves a job waiting for the runner alone
-- ============================================================
-- A delivery order sits 'ready' until the runner comes; the student isn't
-- expected at the counter, so the uncollected clock doesn't run on it.
-- Once it's been brought back (returned_at set), it's the student's to
-- collect or wait for the next round, and the clock runs from the return.
create or replace function public.sweep_orders(p_operator uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  op public.operators;
  n  integer := 0;
  o  public.orders;
  amt text;
begin
  select * into op from public.operators where id = p_operator;
  if op.id is null then return 0; end if;
  if not (public.is_staff(p_operator) or public.is_server()) then
    raise exception 'Not your desk';
  end if;

  perform set_config('printify.gateway', '1', true);

  if op.unpaid_expiry_minutes > 0 then
    for o in
      select * from public.orders x
       where x.operator_id = p_operator and x.status = 'placed'
         and x.payment_claimed_at is null and x.gateway_paid_at is null and x.payment_taken_at is null
         and x.pickup_mode = 'asap'
         and x.created_at < now() - make_interval(mins => op.unpaid_expiry_minutes)
       for update skip locked
    loop
      update public.orders
         set status = 'cancelled', cancelled_by = 'system',
             note = 'Not paid within ' || op.unpaid_expiry_minutes || ' minutes — order again when you''re ready'
       where id = o.id;
      n := n + 1;
    end loop;
  end if;

  if op.unclaimed_after_hours > 0 then
    -- An above-limit cash order the student never set off for: nothing was
    -- printed, nothing is owed — it simply lapses.
    for o in
      select * from public.orders x
       where x.operator_id = p_operator and x.status = 'placed'
         and x.print_on_signal and x.signalled_at is null
         and coalesce(x.pickup_at, x.created_at) < now() - make_interval(hours => op.unclaimed_after_hours)
       for update skip locked
    loop
      update public.orders
         set status = 'cancelled', cancelled_by = 'system',
             note = 'You didn''t set off within ' || op.unclaimed_after_hours || ' hours — order again when you''re ready'
       where id = o.id;
      n := n + 1;
    end loop;

    -- Halfway to the deadline, one reminder — and for a cash order, what
    -- missing it costs.
    for o in
      select * from public.orders x
       where x.operator_id = p_operator and x.status = 'ready'
         and not (x.delivery and x.returned_at is null)
         and x.reminded_at is null
         and coalesce(x.ready_at, x.created_at) < now() - make_interval(mins => op.unclaimed_after_hours * 30)
       for update skip locked
    loop
      amt := coalesce(op.currency, '₹') || trim(to_char(o.total, 'FM999999990.00'));
      update public.orders set reminded_at = now() where id = o.id;
      perform public.notify_student(o.user_id, o.id,
        'Still waiting at ' || coalesce(op.short_name, op.name, 'the desk') || ': token ' || coalesce(o.token, '')
        || '. Collect it within ' || op.unclaimed_after_hours || ' hours of it being ready'
        || case when o.pay_at_pickup and o.payment_taken_at is null and o.gateway_paid_at is null
                then ' — after that it''s cleared from the shelf and ' || amt || ' becomes due on your account.'
                else ' — after that it''s cleared from the shelf.' end);
    end loop;

    for o in
      select * from public.orders x
       where x.operator_id = p_operator and x.status = 'ready'
         and not (x.delivery and x.returned_at is null)
         and coalesce(x.ready_at, x.created_at) < now() - make_interval(hours => op.unclaimed_after_hours)
       for update skip locked
    loop
      update public.orders
         set status = 'unclaimed',
             note = 'Not collected within ' || op.unclaimed_after_hours || ' hours'
       where id = o.id;
      n := n + 1;
    end loop;
  end if;

  return n;
end;
$$;

-- ============================================================
-- 9. What the student — and the runner — are told
-- ============================================================
create or replace function public.queue_order_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ord  public.orders;
  prof public.profiles;
  op   public.operators;
  msg  text;
  amt  text;
  dest text;
  cash boolean;
begin
  if new.status not in ('queued', 'ready', 'delivering', 'failed', 'collected', 'unclaimed', 'cancelled') then
    return new;
  end if;

  -- The row read here is the one before this write (the event is logged
  -- inside the order's BEFORE trigger), so the facts that decide a message
  -- are the older ones, plus the event's own note.
  select * into ord from public.orders where id = new.order_id;
  if ord.id is null or ord.user_id is null then
    return new;
  end if;
  -- Cancelled by the student themselves needs no message; by the desk or
  -- the system, it does.
  if new.status = 'cancelled' and coalesce(new.actor, '') = ord.user_id then
    return new;
  end if;

  select * into prof from public.profiles  where id = ord.user_id;
  select * into op   from public.operators where id = ord.operator_id;

  amt := coalesce(op.currency, '₹')
      || case when ord.total = trunc(ord.total)
              then trim(to_char(ord.total, 'FM999999990'))
              else trim(to_char(ord.total, 'FM999999990.00')) end;
  dest := trim(coalesce(ord.deliver_to ->> 'hostel', '') || ' ' || coalesce(ord.deliver_to ->> 'room', ''));
  cash := ord.pay_at_pickup and ord.payment_taken_at is null and ord.gateway_paid_at is null;

  msg := case new.status
    when 'queued'    then case
                            when new.note like 'Paid online through Printif%'
                            then 'Paid ' || amt || ' online — order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '.'
                            when new.note like 'Cash at the door%'
                            then 'Order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '. Pay ' || amt || ' in cash at your door when it''s delivered.'
                            when new.note like 'Cash at the counter%'
                            then 'Order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '. Pay ' || amt || ' in cash when you collect.'
                            else 'Order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '.'
                          end
    when 'ready'     then case
                            when coalesce(ord.delivery, false) and coalesce(new.note, '') like 'Couldn''t deliver%'
                            then 'We couldn''t deliver order ' || coalesce(ord.token, '') || ' — ' ||
                                 regexp_replace(new.note, '^Couldn''t deliver: (.*) — back at the desk$', '\1') ||
                                 '. It''s back at ' || coalesce(op.short_name, op.name, 'the desk') ||
                                 ': collect it there with your token, or it goes out again on the next round.'
                            when coalesce(ord.delivery, false) and coalesce(new.note, '') like 'Back at the desk%'
                            then 'Order ' || coalesce(ord.token, '') || ' is back at ' || coalesce(op.short_name, op.name, 'the desk') ||
                                 ' — collect it there with your token, or it goes out again on the next round.'
                            when coalesce(ord.delivery, false)
                            then 'Printed. Order ' || coalesce(ord.token, '') || ' goes out to ' || coalesce(nullif(dest, ''), 'your hostel') ||
                                 ' on Printifi''s next delivery round' ||
                                 case when cash then ' — have ' || amt || ' in cash ready at the door.' else '.' end
                            else 'Ready to collect. Show token ' || coalesce(ord.token, '') || ' at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') ||
                                 case when cash then ' and pay ' || amt || ' in cash.' else '.' end
                          end
    when 'delivering' then 'On its way: order ' || coalesce(ord.token, '') || ' is with Printifi''s runner, heading to ' ||
                           coalesce(nullif(dest, ''), 'you') || '. Keep your token''s QR ready at the door' ||
                           case when cash then ', and ' || amt || ' in cash.' else '.' end
    when 'collected' then case when coalesce(ord.delivery, false) and coalesce(new.note, '') like 'Delivered%'
                               then 'Delivered. Thanks!' else 'Collected. Thanks!' end
    when 'unclaimed' then 'Order ' || coalesce(ord.token, '') || ' wasn''t collected and has been cleared from the shelf at ' ||
                          coalesce(op.short_name, op.name, 'Printifi') ||
                          case when cash and current_setting('printify.gateway', true) = '1'
                               then '. ' || amt || ' is now due on your account — pay it in the app to order again.'
                               else '. Ask at the counter if you still need it.' end
    when 'cancelled' then 'Order ' || coalesce(ord.token, '') || ' was cancelled' || coalesce(': ' || new.note, '') || '.'
    else 'We could not print your order' || coalesce(': ' || ord.note, '') || '.'
  end;

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

  -- A delivery job filed on a shelf: every active runner with a desk device
  -- hears where to go. Not when a runner has just brought it back — they know.
  if new.status = 'ready' and coalesce(ord.delivery, false) and coalesce(new.note, '') not like 'Couldn''t deliver%' then
    insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail, audience)
    select r.user_id, new.order_id, 'push', null,
           'Delivery ready at ' || coalesce(op.short_name, op.name, 'a desk') || ': ' || coalesce(ord.token, '') ||
           ' → ' || coalesce(nullif(dest, ''), 'no room given') ||
           case when cash then ' · ' || amt || ' cash at the door' else ' · paid' end,
           'queued', null, 'desk'
      from public.runners r
     where r.status = 'active'
       and exists (select 1 from public.push_subscriptions ps where ps.user_id = r.user_id and ps.desk);
  end if;

  return new;
end;
$$;

-- ============================================================
-- 10. The desk's numbers: cash the runner took isn't in the till
-- ============================================================
-- Revenue counts the desk's bill (the delivery fee was never its), and the
-- cash column counts what went through the desk's own hands — cash the
-- runner took at a door is its own column, credited in Takings.
drop function if exists public.operator_stats_range(uuid, timestamptz, timestamptz);
create or replace function public.operator_stats_range(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (
  orders integer, collected integer, declined integer, pages integer, colour_pages integer,
  revenue numeric, refunded numeric, cash_total numeric, upi_total numeric, online_total numeric,
  uncollected integer, median_minutes integer, platform_fee numeric, delivery_cash numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_owner(p_operator) or public.is_admin() or public.is_server()) then return; end if;

  return query
  with mine as (
    select * from public.orders o
    where o.operator_id = p_operator and o.created_at >= p_from and o.created_at < p_to
  ), done as (
    select * from mine where mine.status in ('collected', 'unclaimed')
  ), door as (
    -- Cash taken at the door by Printifi's runner: never in the desk's till.
    select * from done where done.delivery and done.delivered_at is not null
                         and done.pay_at_pickup and done.gateway_paid_at is null
  )
  select
    (select count(*)::integer from mine),
    (select count(*)::integer from mine where mine.status = 'collected'),
    (select count(*)::integer from mine where mine.status in ('cancelled', 'failed')),
    (select coalesce(sum(done.pages), 0)::integer from done),
    (select coalesce(sum(done.colour_pages), 0)::integer from done),
    (select coalesce(sum(done.total - coalesce(done.delivery_fee, 0)), 0) from done),
    (select coalesce(sum(mine.refund_amount), 0) from mine where mine.refunded_at is not null),
    (select coalesce(sum(done.total), 0) from done where done.payment_method = 'cash'
       and not (done.delivery and done.delivered_at is not null and done.pay_at_pickup and done.gateway_paid_at is null)),
    (select coalesce(sum(done.total), 0) from done where done.payment_method = 'upi'),
    (select coalesce(sum(done.total), 0) from done where done.payment_method = 'gateway'),
    (select count(*)::integer from mine where mine.status = 'ready'),
    (select coalesce(percentile_cont(0.5) within group (
       order by extract(epoch from (mine.collected_at - mine.created_at)) / 60), 0)::integer
     from mine where mine.collected_at is not null),
    (select coalesce(sum(done.platform_fee), 0) from done
      where done.refund_amount is null or done.refund_amount < done.total),
    (select coalesce(sum(door.total), 0) from door);
end;
$$;
grant execute on function public.operator_stats_range(uuid, timestamptz, timestamptz) to authenticated;

-- Takings names the two new kinds of credit.
drop function if exists public.desk_credit_summary(uuid);
create or replace function public.desk_credit_summary(p_operator uuid)
returns table (
  covered_orders integer, covered numeric, dues_taken numeric, via_payout numeric, via_fee numeric,
  delivery_orders integer, delivery_cash numeric, delivery_fees numeric
)
language sql stable security definer set search_path = public as $$
  select * from (
    select count(*) filter (where d.kind = 'unclaimed')::integer,
           coalesce(sum(d.amount) filter (where d.kind = 'unclaimed'), 0)::numeric,
           coalesce(-sum(d.amount) filter (where d.kind = 'dues_cash'), 0)::numeric,
           coalesce(sum(d.amount) filter (where d.applied_to = 'payout'), 0)::numeric,
           coalesce(sum(d.amount) filter (where d.applied_to = 'fee'), 0)::numeric,
           count(*) filter (where d.kind = 'delivery_cash')::integer,
           coalesce(sum(d.amount) filter (where d.kind = 'delivery_cash'), 0)::numeric,
           coalesce(-sum(d.amount) filter (where d.kind = 'delivery_fee'), 0)::numeric
      from public.desk_credits d
     where d.operator_id = p_operator
  ) s
  where public.is_staff(p_operator) or public.is_admin() or public.is_server();
$$;
grant execute on function public.desk_credit_summary(uuid) to authenticated;

-- The statement: a credit line carries its kind where a Cashfree reference would be.
drop function if exists public.payout_orders(uuid, timestamptz, timestamptz);
create or replace function public.payout_orders(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (
  id uuid, token text, paid_at timestamptz, status text,
  total numeric, platform_fee numeric, refund_amount numeric, share numeric, payment_id text
)
language sql stable security definer set search_path = public as $$
  select * from (
    select o.id, o.token, o.gateway_paid_at as paid_at, o.status::text as status,
           o.total, o.platform_fee, o.refund_amount, public.desk_share(o) as share, o.gateway_payment_id as payment_id
      from public.orders o
     where o.operator_id = p_operator
       and o.gateway_paid_at >= p_from and o.gateway_paid_at < p_to
       and not o.gateway_split
    union all
    select d.order_id, o.token, d.created_at,
           case d.kind when 'unclaimed' then 'covered' when 'dues_cash' then 'dues taken'
                       when 'delivery_cash' then 'delivered, cash at the door' else 'delivery fee' end,
           coalesce(o.total, 0), coalesce(o.platform_fee, 0), null::numeric, d.amount,
           case d.kind when 'unclaimed' then 'Covered by Printifi' when 'dues_cash' then 'Cash for dues'
                       when 'delivery_cash' then 'Cash taken by Printifi''s runner' else 'Delivery fee you were paid' end
      from public.desk_credits d
      left join public.orders o on o.id = d.order_id
     where d.operator_id = p_operator and d.applied_to = 'payout'
       and d.created_at >= p_from and d.created_at < p_to
  ) lines
  where public.is_owner(p_operator) or public.is_admin() or public.is_server()
  order by paid_at desc
  limit 500;
$$;
grant execute on function public.payout_orders(uuid, timestamptz, timestamptz) to authenticated;

-- ============================================================
-- 11. Grants (0036: nothing is callable until it's granted here)
-- ============================================================
grant execute on function public.request_runner(text)                              to authenticated;
grant execute on function public.admin_runners()                                   to authenticated;
grant execute on function public.admin_set_runner(text, boolean)                   to authenticated;
grant execute on function public.admin_add_runner(text)                            to authenticated;
grant execute on function public.runner_orders()                                   to authenticated;
grant execute on function public.runner_pickup(uuid)                               to authenticated;
grant execute on function public.runner_deliver(uuid, text)                        to authenticated;
grant execute on function public.runner_return(uuid, text)                         to authenticated;
grant execute on function public.set_delivery_policy(boolean, numeric, text[], text) to authenticated;
grant execute on function public.set_desk_delivery(uuid, boolean)                  to authenticated;
grant execute on function public.admin_delivery_report()                           to authenticated;
-- is_runner: read inside definer bodies.

commit;
