-- Print Counter — to the paisa, and the bill stays true.
--
-- Run after 0016.
--
-- Two changes to how an order is priced:
--
-- 1. Amounts are kept to the paisa. `place_order()` rounded the order to a
--    whole rupee, so an operator who set ₹1.50 a page charged ₹5 for three
--    pages. Each file's price is now round-half-up to two decimals, the total
--    is the sum of those prices (so a bill always adds up), and the minimum
--    order is an explicit top-up rather than a silent lift.
--
-- 2. The order remembers the rate card it was priced with. Rates change; a
--    bill shown next month must show next month's student what they were
--    actually charged and why, not a recomputation at whatever the desk
--    charges then.

alter table public.orders add column if not exists rate_card jsonb;

-- Items had no notion of order. Their ids are random UUIDs, so a bill listed
-- them in whatever order the index returned them — different from the order
-- the student added them in, and different from one load to the next.
alter table public.order_items add column if not exists ordinal smallint not null default 0;
create index if not exists order_items_ordinal on public.order_items (order_id, ordinal);

comment on column public.orders.rate_card is
  'The operator''s rates at the moment of pricing. The bill is recomputed from '
  'this and the items, never from the live operator row.';

/**
 * A float8 amount to the paisa, rounded exactly as `Math.round(x * 100) / 100`
 * rounds it in the browser — because the bill the student saw must be the
 * bill that is stored, to the paisa, every time.
 *
 * Neither of Postgres's obvious routes does that. Casting float8 to numeric
 * first rounds to fifteen significant digits, so 56686.49999999999 becomes
 * 56686.5 before round() sees it, and the browser — which rounds the exact
 * double — says 56686. And round(float8) is round-half-to-even, which the
 * browser is not: 412.5 is 413 there and 412 here. So the rule is spelled
 * out: on the double itself, halves and above go up, the rest go down.
 */
create or replace function public.to_paise(x double precision)
returns numeric language sql immutable as $$
  select (case when (x * 100) - floor(x * 100) >= 0.5
               then ceil(x * 100)
               else floor(x * 100) end)::numeric / 100
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

  insert into public.orders (
    user_id, operator_id, total, full_colour_total, pages, colour_pages, config,
    pickup_mode, pickup_at, rate_card
  ) values (
    me, p_operator,
    greatest(subtotal, min_order),
    greatest(full_sum, min_order),
    pages_total, colour_total, first_cfg,
    case when p_pickup_at is null then 'asap' else 'scheduled' end, p_pickup_at,
    jsonb_build_object(
      'currency',        op.currency,
      'bw_per_page',     op.bw_per_page,
      'colour_per_page', op.colour_per_page,
      'duplex_discount', op.duplex_discount,
      'staple_price',    op.staple_price,
      'bulk_threshold',  op.bulk_threshold,
      'bulk_multiplier', op.bulk_multiplier,
      'min_order',       op.min_order,
      'paper_gsm',       op.paper_gsm
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

-- The snapshot is the bill's evidence; a student must not be able to edit it.
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
