-- 0050: when the runner is on, and a pin on the map.
--
-- Run after 0049.
--
-- Two things a student asked for, kept simple.
--
--   * The runner says when they're delivering — "today, 12:00 to 15:00" —
--     from their own page, since they're the one who knows. Students see
--     it when they order ("Delivery today 12:00–3:00 pm. Where will you
--     be?") and in the "printed" message; when a window opens, every
--     student with a printed delivery waiting is told. It replaces the
--     admin's fixed round times where one is set; the rounds stay as the
--     fallback words when no runner has said anything.
--
--   * A pin on the map, beside the spot: the student's phone says where
--     they are (±the accuracy the phone reports), they can drag it, and
--     the runner gets a "Navigate" link and the distance from where they
--     stand. A pin is precise personal data, so it lives on the order only
--     and is wiped the moment the order ends.

begin;

-- ============================================================
-- 1. The runner's window
-- ============================================================
alter table public.runners
  add column if not exists on_from  timestamptz,
  add column if not exists on_until timestamptz;

/**
 * The runner's own window. Null and null clears it. Up to 16 hours, ending
 * within the next 24, and it may already have started. Opening a window
 * tells every student with a printed delivery waiting when it comes.
 */
create or replace function public.set_runner_window(p_from timestamptz, p_until timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare
  me  text := public.clerk_id();
  tz  text;
  o   public.orders;
  op  public.operators;
begin
  if not public.is_runner() then raise exception 'You''re not a runner on Printifi'; end if;
  if p_from is null and p_until is null then
    update public.runners set on_from = null, on_until = null where user_id = me;
    return;
  end if;
  if p_from is null or p_until is null then raise exception 'A window has a start and an end'; end if;
  if p_until <= p_from then raise exception 'The window ends before it starts'; end if;
  if p_until <= now() then raise exception 'That window is already over'; end if;
  if p_until - p_from > interval '16 hours' then raise exception 'A window is at most sixteen hours'; end if;
  if p_until > now() + interval '24 hours' then raise exception 'Set a window for the next day, not later'; end if;
  update public.runners set on_from = p_from, on_until = p_until where user_id = me;

  -- Printed deliveries waiting on a shelf: they now know when.
  select coalesce(s.delivery_tz, 'Asia/Kolkata') into tz from public.platform_settings s where s.id;
  for o in
    select * from public.orders x where x.delivery and x.status = 'ready' and x.returned_at is null
  loop
    select * into op from public.operators where id = o.operator_id;
    perform public.notify_student(o.user_id, o.id,
      'Printifi''s runner is on ' || public.window_words(p_from, p_until, tz) || ' — order ' || coalesce(o.token, '')
      || ' comes to ' || coalesce(public.delivery_place(o), 'you') || ' then.'
      || case when o.pay_at_pickup and o.payment_taken_at is null and o.gateway_paid_at is null
              then ' Have ' || coalesce(op.currency, '₹') || trim(to_char(o.total, 'FM999999990.00')) || ' in cash ready.' else '' end);
  end loop;
end;
$$;
grant execute on function public.set_runner_window(timestamptz, timestamptz) to authenticated;

/** "today 12:00–3:00 pm" / "tomorrow 9:00 am–1:00 pm", in the platform's timezone. */
create or replace function public.window_words(p_from timestamptz, p_until timestamptz, p_tz text default 'Asia/Kolkata')
returns text language sql stable as $$
  select case
           when (p_from at time zone p_tz)::date = (now() at time zone p_tz)::date then 'today '
           when (p_from at time zone p_tz)::date = (now() at time zone p_tz)::date + 1 then 'tomorrow '
           else to_char(p_from at time zone p_tz, 'DD Mon ') end
      || trim(leading '0' from to_char(p_from at time zone p_tz, 'HH12:MI am')) || '–'
      || trim(leading '0' from to_char(p_until at time zone p_tz, 'HH12:MI am'))
$$;

/**
 * When delivery is on, for anyone: the earliest start and the latest end
 * across active runners whose window hasn't ended. Nothing when nobody
 * has said. Signed out or in — it's what the sheet shows before ordering.
 */
drop function if exists public.delivery_window();
create or replace function public.delivery_window()
returns table (on_from timestamptz, on_until timestamptz, words text)
language sql stable security definer set search_path = public as $$
  select w.f, w.u, public.window_words(w.f, w.u, coalesce((select s.delivery_tz from public.platform_settings s where s.id), 'Asia/Kolkata'))
    from (
      select min(r.on_from) as f, max(r.on_until) as u
        from public.runners r
       where r.status = 'active' and r.on_until > now()
    ) w
   where w.f is not null
$$;
grant execute on function public.delivery_window() to anon, authenticated;

-- ============================================================
-- 2. The pin
-- ============================================================
/** A pin the student sent: lat, lng, and the phone's accuracy in metres. Null when there isn't one, or it's nonsense. */
create or replace function public.clean_pin(p jsonb)
returns jsonb language plpgsql immutable as $$
declare
  lat numeric; lng numeric; acc numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return null; end if;
  begin
    lat := (p ->> 'lat')::numeric; lng := (p ->> 'lng')::numeric; acc := coalesce((p ->> 'acc')::numeric, 0);
  exception when others then return null; end;
  if lat is null or lng is null or lat < -90 or lat > 90 or lng < -180 or lng > 180 then return null; end if;
  if acc < 0 or acc > 5000 then acc := null; end if;
  return jsonb_strip_nulls(jsonb_build_object('lat', round(lat, 6), 'lng', round(lng, 6), 'acc', round(acc)));
end;
$$;

-- Placing: the pin rides inside p_delivery as {lat, lng, acc}. Same body as
-- 0048's with that one addition.
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
  wants_delivery boolean := false;
  spot         text;
  detail       text;
  pin          jsonb;
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
    wants_delivery := true;
    spot   := nullif(trim(coalesce(p_delivery ->> 'spot', p_delivery ->> 'hostel', '')), '');
    detail := nullif(trim(coalesce(p_delivery ->> 'detail', p_delivery ->> 'room', '')), '');
    pin    := public.clean_pin(p_delivery -> 'pin');
    if spot is not null and length(spot) > 60 then raise exception 'Keep the spot short — a place name'; end if;
    if detail is not null and length(detail) > 60 then raise exception 'Keep the detail short — a room number, or where exactly'; end if;
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
    wants_delivery,
    dfee,
    case when wants_delivery
         then jsonb_strip_nulls(jsonb_build_object('spot', spot, 'detail', detail, 'changed_at', now())) || coalesce(pin, '{}'::jsonb)
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

-- Moving: the pin comes along, or goes (a move without a pin drops the old one —
-- a pin from the library is wrong at the canteen). The signature grows, so
-- the old one is dropped first.
drop function if exists public.set_delivery_spot(uuid, text, text);
create or replace function public.set_delivery_spot(p_order uuid, p_spot text, p_detail text default null, p_pin jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  o      public.orders;
  spot   text := nullif(trim(coalesce(p_spot, '')), '');
  detail text := nullif(trim(coalesce(p_detail, '')), '');
  pin    jsonb := public.clean_pin(p_pin);
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
  if spot is null and detail is null and pin is null then raise exception 'Say where you''ll be — a place, a landmark, or a pin'; end if;
  if spot is not null and length(spot) > 60 then raise exception 'Keep the spot short — a place name'; end if;
  if detail is not null and length(detail) > 60 then raise exception 'Keep the detail short — a room number, or where exactly'; end if;

  perform set_config('printify.gateway', '1', true);
  update public.orders
     set deliver_to = jsonb_strip_nulls(jsonb_build_object('spot', spot, 'detail', detail, 'changed_at', now())) || coalesce(pin, '{}'::jsonb)
   where id = o.id;

  if o.status = 'delivering' and o.runner_id is not null then
    place := coalesce(nullif(concat_ws(', ', spot, detail), ''), 'a pinned spot');
    insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail, audience)
    values (o.runner_id, o.id, 'push', null,
            coalesce(o.token, 'Order') || ' moved: now at ' || place || case when pin is not null then ' (pinned)' else '' end || '.',
            case when exists (select 1 from public.push_subscriptions s where s.user_id = o.runner_id and s.desk) then 'queued' else 'skipped' end,
            case when exists (select 1 from public.push_subscriptions s where s.user_id = o.runner_id and s.desk) then null else 'No desk device subscribed.' end,
            'desk');
  end if;
end;
$$;
grant execute on function public.set_delivery_spot(uuid, text, text, jsonb) to authenticated;

-- A pin is where a person was. It has no business outliving the job.
create or replace function public.scrub_delivery_pin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('collected', 'unclaimed', 'cancelled', 'failed') and new.deliver_to ? 'lat' then
    new.deliver_to := new.deliver_to - 'lat' - 'lng' - 'acc';
  end if;
  return new;
end;
$$;
drop trigger if exists orders_scrub_pin on public.orders;
create trigger orders_scrub_pin
  before update of status on public.orders
  for each row execute function public.scrub_delivery_pin();

-- The runner's list carries the pin.
drop function if exists public.runner_orders();
create or replace function public.runner_orders()
returns table (
  id uuid, token text, status text, operator_id uuid, desk text, campus text,
  student text, phone text, spot text, detail text, spot_changed_at timestamptz,
  lat numeric, lng numeric, acc numeric,
  pages integer, total numeric, cash_due numeric, delivery_fee numeric,
  ready_at timestamptz, picked_up_at timestamptz, delivered_at timestamptz, returned_at timestamptz,
  delivery_returns integer, runner_id text, mine boolean, shelf_slot text, note text, delivery_proof text
)
language sql stable security definer set search_path = public as $$
  select o.id, o.token, o.status::text, o.operator_id, coalesce(nullif(op.short_name, ''), op.name), op.campus,
         p.name, p.phone, public.delivery_spot(o), public.delivery_detail(o),
         nullif(o.deliver_to ->> 'changed_at', '')::timestamptz,
         (o.deliver_to ->> 'lat')::numeric, (o.deliver_to ->> 'lng')::numeric, (o.deliver_to ->> 'acc')::numeric,
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
-- 3. The "printed" message names the window when a runner has said one
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
  whn  text;
  cash boolean;
begin
  if new.status not in ('queued', 'ready', 'delivering', 'failed', 'collected', 'unclaimed', 'cancelled') then
    return new;
  end if;

  select * into ord from public.orders where id = new.order_id;
  if ord.id is null or ord.user_id is null then
    return new;
  end if;
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
  cash := ord.pay_at_pickup and ord.payment_taken_at is null and ord.gateway_paid_at is null;
  -- When it comes: the runner's window if one is set, else the round, else
  -- the next round in plain words.
  if coalesce(ord.delivery, false) then
    select ' ' || w.words into whn from public.delivery_window() w limit 1;
    if whn is null then
      whn := case when public.next_delivery_round(now()) is not null
                  then ' on the ' || public.next_delivery_round(now()) || ' round'
                  else ' when the runner is next on' end;
    end if;
  end if;

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
                                 ': collect it there with your token, or it goes out again when the runner is next on.'
                            when coalesce(ord.delivery, false) and coalesce(new.note, '') like 'Back at the desk%'
                            then 'Order ' || coalesce(ord.token, '') || ' is back at ' || coalesce(op.short_name, op.name, 'the desk') ||
                                 ' — collect it there with your token, or it goes out again when the runner is next on.'
                            when coalesce(ord.delivery, false) and dest is null
                            then 'Printed. Order ' || coalesce(ord.token, '') || ' comes to you' || whn ||
                                 ' — set where you''ll be in the app so the runner knows, or they''ll call you.' ||
                                 case when cash then ' Have ' || amt || ' in cash ready.' else '' end
                            when coalesce(ord.delivery, false)
                            then 'Printed. Order ' || coalesce(ord.token, '') || ' comes to ' || dest || whn ||
                                 '. Somewhere else by then? Change the spot in the app.' ||
                                 case when cash then ' Have ' || amt || ' in cash ready.' else '' end
                            else 'Ready to collect. Show token ' || coalesce(ord.token, '') || ' at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') ||
                                 case when cash then ' and pay ' || amt || ' in cash.' else '.' end
                          end
    when 'delivering' then 'On its way: order ' || coalesce(ord.token, '') || ' is with Printifi''s runner' ||
                           case when dest is null
                                then ' — they''ll call you. Set where you''ll be in the app to save them the call.'
                                else ', coming to ' || dest || '. Still there? If not, change the spot in the app now.' end ||
                           ' Keep your token''s QR ready' ||
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

  if new.status = 'ready' and coalesce(ord.delivery, false) and coalesce(new.note, '') not like 'Couldn''t deliver%' then
    insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail, audience)
    select r.user_id, new.order_id, 'push', null,
           'Delivery ready at ' || coalesce(op.short_name, op.name, 'a desk') || ': ' || coalesce(ord.token, '') ||
           ' → ' || coalesce(dest, 'no spot yet — call them') || case when ord.deliver_to ? 'lat' then ' (pinned)' else '' end ||
           case when cash then ' · ' || amt || ' cash on handover' else ' · paid' end,
           case when exists (select 1 from public.push_subscriptions ps where ps.user_id = r.user_id and ps.desk) then 'queued' else 'skipped' end,
           case when exists (select 1 from public.push_subscriptions ps where ps.user_id = r.user_id and ps.desk) then null else 'No desk device subscribed.' end,
           'desk'
      from public.runners r
     where r.status = 'active';
  end if;

  return new;
end;
$$;

commit;
