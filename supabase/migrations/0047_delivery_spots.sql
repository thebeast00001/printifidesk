-- 0047: a delivery goes where the student will be, not where they live.
--
-- Run after 0046.
--
-- 0046 asked for a hostel and a room. A student isn't a fixed point: they
-- order from bed and are in the library when the round comes. So:
--
--   * the admin's list is now a list of SPOTS on campus — hostels, the
--     library entrance, a block's gate, the canteen — and the student picks
--     the spot plus a line of detail (a room number, "near the steps");
--   * the choice is framed by the ROUND: the platform keeps the times its
--     rounds leave, and the app asks "the 1:00 pm round — where will you
--     be?" rather than "where are you now?";
--   * the student can CHANGE the spot any time until it's handed over.
--     Before the runner sets off, quietly. Once it's on its way, the runner
--     is pushed the new spot at once, and the "on its way" message asks the
--     student to confirm or change it.
--
-- `deliver_to` stays a jsonb: {spot, detail, changed_at}. Rows from 0046
-- carry {hostel, room}; everything here reads the old keys as fallbacks.

begin;

alter table public.platform_settings
  add column if not exists delivery_rounds text[] not null default '{}',
  add column if not exists delivery_tz     text   not null default 'Asia/Kolkata';

-- ============================================================
-- 1. Where and what: helpers over the jsonb
-- ============================================================
/** The spot a delivery goes to — 0047's key, or 0046's hostel. */
create or replace function public.delivery_spot(o public.orders)
returns text language sql immutable as $$
  select nullif(trim(coalesce(o.deliver_to ->> 'spot', o.deliver_to ->> 'hostel', '')), '')
$$;

/** The line of detail — a room number, "near the steps" — 0047's key, or 0046's room. */
create or replace function public.delivery_detail(o public.orders)
returns text language sql immutable as $$
  select nullif(trim(coalesce(o.deliver_to ->> 'detail', o.deliver_to ->> 'room', '')), '')
$$;

/** "Ganga hostel, 213" — the two joined, for a message. */
create or replace function public.delivery_place(o public.orders)
returns text language sql immutable as $$
  select nullif(concat_ws(', ', public.delivery_spot(o), public.delivery_detail(o)), '')
$$;

/**
 * The next round after a moment, as the student reads it ("1:00 pm"), in
 * the platform's timezone — or null when no rounds are set. A round that
 * leaves at the very minute counts as still to come. Past the last round
 * of the day, the first round of the next.
 */
create or replace function public.next_delivery_round(p_at timestamptz default now())
returns text language plpgsql stable security definer set search_path = public as $$
declare
  s      public.platform_settings;
  local_t time;
  r      text;
  best   time;
begin
  select * into s from public.platform_settings where id;
  if s.id is null or coalesce(array_length(s.delivery_rounds, 1), 0) = 0 then return null; end if;
  local_t := (p_at at time zone coalesce(s.delivery_tz, 'Asia/Kolkata'))::time;
  for r in select unnest(s.delivery_rounds) order by 1 loop
    if r::time >= local_t and (best is null or r::time < best) then best := r::time; end if;
  end loop;
  if best is null then
    select min(x::time) into best from unnest(s.delivery_rounds) x;
  end if;
  return trim(leading '0' from to_char(best, 'HH12:MI am'));
end;
$$;

-- ============================================================
-- 2. The policy: spots and rounds
-- ============================================================
drop function if exists public.set_delivery_policy(boolean, numeric, text[], text);
create or replace function public.set_delivery_policy(
  p_enabled boolean, p_fee numeric, p_areas text[], p_note text default null, p_rounds text[] default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  clean  text[];
  rounds text[];
  r      text;
begin
  if not public.is_admin() then raise exception 'Only the admin sets delivery'; end if;
  if p_fee is null or p_fee < 0 or p_fee > 200 then raise exception 'The delivery fee is 0 to 200'; end if;
  select coalesce(array_agg(distinct trim(a) order by trim(a)), '{}')
    into clean
    from unnest(coalesce(p_areas, '{}'::text[])) a
   where length(trim(a)) between 1 and 60;
  if coalesce(array_length(clean, 1), 0) > 60 then raise exception 'Up to sixty spots'; end if;
  -- Rounds as HH:MM, 24-hour, in the platform's timezone; a dozen at most.
  rounds := '{}';
  for r in select trim(x) from unnest(coalesce(p_rounds, '{}'::text[])) x where length(trim(x)) > 0 loop
    if r !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'A round time is HH:MM, like 13:00 — not "%"', r;
    end if;
    r := lpad(r, 5, '0');
    if not (r = any (rounds)) then rounds := rounds || r; end if;
  end loop;
  if array_length(rounds, 1) > 12 then raise exception 'Up to twelve rounds a day'; end if;
  select coalesce(array_agg(x order by x), '{}') into rounds from unnest(rounds) x;
  update public.platform_settings
     set delivery_enabled = coalesce(p_enabled, false),
         delivery_fee = round(p_fee, 2),
         delivery_areas = clean,
         delivery_note = nullif(left(trim(coalesce(p_note, '')), 200), ''),
         delivery_rounds = rounds,
         updated_by = public.clerk_id(), updated_at = now()
   where id;
end;
$$;
grant execute on function public.set_delivery_policy(boolean, numeric, text[], text, text[]) to authenticated;

-- ============================================================
-- 3. Placing: a spot and a detail
-- ============================================================
-- Same body as 0046's, with the delivery block reading {spot, detail}
-- (or the old {hostel, room}) and stamping when it was set.
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
  spot         text;
  detail       text;
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

  -- 0046/0047: delivery. Only where the platform and this desk offer it,
  -- only to a spot on the list (when there is one), with a phone the
  -- runner can call. The fee is the platform's, taken as it stands today.
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
    spot   := nullif(trim(coalesce(p_delivery ->> 'spot', p_delivery ->> 'hostel', '')), '');
    detail := nullif(trim(coalesce(p_delivery ->> 'detail', p_delivery ->> 'room', '')), '');
    if spot is null or length(spot) > 60 then raise exception 'Where should it come to?'; end if;
    if detail is not null and length(detail) > 60 then raise exception 'Keep the detail short — a room number, or where exactly'; end if;
    if coalesce(array_length(ps.delivery_areas, 1), 0) > 0 and not (spot = any (ps.delivery_areas)) then
      raise exception 'Printifi doesn''t deliver to % yet — pick a spot from the list', spot;
    end if;
    select p.phone into ph from public.profiles p where p.id = me;
    if ph is null or length(trim(ph)) < 8 then
      raise exception 'Add your phone number so the runner can reach you';
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
    spot is not null,
    dfee,
    case when spot is not null
         then jsonb_strip_nulls(jsonb_build_object('spot', spot, 'detail', detail, 'changed_at', now()))
         else null end
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

-- ============================================================
-- 4. Moving: the student's spot, until it's handed over
-- ============================================================
/**
 * The student says where they'll be. Any time while the job is live;
 * before the runner sets off it's a quiet edit, once it's on its way the
 * runner is pushed the new spot at once. The same checks as at placing.
 */
create or replace function public.set_delivery_spot(p_order uuid, p_spot text, p_detail text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  o      public.orders;
  ps     public.platform_settings;
  spot   text := nullif(trim(coalesce(p_spot, '')), '');
  detail text := nullif(trim(coalesce(p_detail, '')), '');
  place  text;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null or o.user_id <> coalesce(public.clerk_id(), '') then
    raise exception 'Not your order';
  end if;
  if not coalesce(o.delivery, false) then raise exception 'This order is collected at the desk'; end if;
  if o.status not in ('placed', 'queued', 'printing', 'finishing', 'ready', 'delivering') then
    raise exception 'This order is over';
  end if;
  select * into ps from public.platform_settings where id;
  if spot is null or length(spot) > 60 then raise exception 'Where should it come to?'; end if;
  if detail is not null and length(detail) > 60 then raise exception 'Keep the detail short — a room number, or where exactly'; end if;
  if coalesce(array_length(ps.delivery_areas, 1), 0) > 0 and not (spot = any (ps.delivery_areas)) then
    raise exception 'Printifi doesn''t deliver to % yet — pick a spot from the list', spot;
  end if;

  perform set_config('printify.gateway', '1', true);
  update public.orders
     set deliver_to = jsonb_strip_nulls(jsonb_build_object('spot', spot, 'detail', detail, 'changed_at', now()))
   where id = o.id;

  -- Already in a runner's hands: they hear it now, on their desk device.
  if o.status = 'delivering' and o.runner_id is not null then
    place := concat_ws(', ', spot, detail);
    insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail, audience)
    values (o.runner_id, o.id, 'push', null,
            coalesce(o.token, 'Order') || ' moved: now at ' || place || '.',
            case when exists (select 1 from public.push_subscriptions s where s.user_id = o.runner_id and s.desk) then 'queued' else 'skipped' end,
            case when exists (select 1 from public.push_subscriptions s where s.user_id = o.runner_id and s.desk) then null else 'No desk device subscribed.' end,
            'desk');
  end if;
end;
$$;
grant execute on function public.set_delivery_spot(uuid, text, text) to authenticated;

-- ============================================================
-- 5. The runner's list says the spot, the detail, and when it last moved
-- ============================================================
drop function if exists public.runner_orders();
create or replace function public.runner_orders()
returns table (
  id uuid, token text, status text, operator_id uuid, desk text, campus text,
  student text, phone text, spot text, detail text, spot_changed_at timestamptz,
  pages integer, total numeric, cash_due numeric, delivery_fee numeric,
  ready_at timestamptz, picked_up_at timestamptz, delivered_at timestamptz, returned_at timestamptz,
  delivery_returns integer, runner_id text, mine boolean, shelf_slot text, note text, delivery_proof text
)
language sql stable security definer set search_path = public as $$
  select o.id, o.token, o.status::text, o.operator_id, coalesce(nullif(op.short_name, ''), op.name), op.campus,
         p.name, p.phone, public.delivery_spot(o), public.delivery_detail(o),
         nullif(o.deliver_to ->> 'changed_at', '')::timestamptz,
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
grant execute on function public.runner_orders() to authenticated;

-- ============================================================
-- 6. What the student — and the runner — are told, with the spot and the round
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
  rnd  text;
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
  dest := public.delivery_place(ord);
  rnd  := case when coalesce(ord.delivery, false) then public.next_delivery_round(now()) else null end;
  cash := ord.pay_at_pickup and ord.payment_taken_at is null and ord.gateway_paid_at is null;

  msg := case new.status
    when 'queued'    then case
                            when new.note like 'Paid online through Printif%'
                            then 'Paid ' || amt || ' online — order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '.'
                            when new.note like 'Cash at the door%'
                            then 'Order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '. Pay ' || amt || ' in cash when it''s handed to you.'
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
                            then 'Printed. Order ' || coalesce(ord.token, '') || ' comes to ' || coalesce(dest, 'the spot you chose') ||
                                 case when rnd is not null then ' on the ' || rnd || ' round' else ' on Printifi''s next round' end ||
                                 '. Somewhere else by then? Change the spot in the app.' ||
                                 case when cash then ' Have ' || amt || ' in cash ready.' else '' end
                            else 'Ready to collect. Show token ' || coalesce(ord.token, '') || ' at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') ||
                                 case when cash then ' and pay ' || amt || ' in cash.' else '.' end
                          end
    when 'delivering' then 'On its way: order ' || coalesce(ord.token, '') || ' is with Printifi''s runner, coming to ' ||
                           coalesce(dest, 'you') || '. Still there? If not, change the spot in the app now. Keep your token''s QR ready' ||
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
           ' → ' || coalesce(dest, 'no spot given') ||
           case when cash then ' · ' || amt || ' cash on handover' else ' · paid' end,
           'queued', null, 'desk'
      from public.runners r
     where r.status = 'active'
       and exists (select 1 from public.push_subscriptions ps where ps.user_id = r.user_id and ps.desk);
  end if;

  return new;
end;
$$;

commit;
