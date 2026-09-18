-- 0048: the spot is the student's words, not a whitelist.
--
-- Run after 0047.
--
-- 0047 refused a delivery whose spot wasn't on the admin's list. With one
-- hostel on the list, a student in a lecture block had nothing to pick
-- and couldn't order. The list is now quick picks: the student can type
-- any spot on campus, or leave it blank and be reached by phone (which a
-- delivery still requires). The runner's list and the messages say so
-- when no spot was given.

begin;

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

  -- 0046–0048: delivery. Only where the platform and this desk offer it,
  -- with a phone the runner can call. The spot is the student's words —
  -- the admin's list is quick picks, not a fence — and may be blank: the
  -- runner then calls. The fee is the platform's, taken as it stands today.
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
    wants_delivery,
    dfee,
    case when wants_delivery
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

-- Moving: any spot in the student's words; something must be said.
create or replace function public.set_delivery_spot(p_order uuid, p_spot text, p_detail text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  o      public.orders;
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
  if spot is null and detail is null then raise exception 'Say where you''ll be — a place, or a landmark'; end if;
  if spot is not null and length(spot) > 60 then raise exception 'Keep the spot short — a place name'; end if;
  if detail is not null and length(detail) > 60 then raise exception 'Keep the detail short — a room number, or where exactly'; end if;

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

-- The messages when no spot was given: the runner will call; set one in the app.
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
                            when coalesce(ord.delivery, false) and dest is null
                            then 'Printed. Order ' || coalesce(ord.token, '') || ' comes to you' ||
                                 case when rnd is not null then ' on the ' || rnd || ' round' else ' on Printifi''s next round' end ||
                                 ' — set where you''ll be in the app so the runner knows, or they''ll call you.' ||
                                 case when cash then ' Have ' || amt || ' in cash ready.' else '' end
                            when coalesce(ord.delivery, false)
                            then 'Printed. Order ' || coalesce(ord.token, '') || ' comes to ' || dest ||
                                 case when rnd is not null then ' on the ' || rnd || ' round' else ' on Printifi''s next round' end ||
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

  -- A delivery job filed on a shelf: every active runner with a desk device
  -- hears where to go. Not when a runner has just brought it back — they know.
  if new.status = 'ready' and coalesce(ord.delivery, false) and coalesce(new.note, '') not like 'Couldn''t deliver%' then
    insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail, audience)
    select r.user_id, new.order_id, 'push', null,
           'Delivery ready at ' || coalesce(op.short_name, op.name, 'a desk') || ': ' || coalesce(ord.token, '') ||
           ' → ' || coalesce(dest, 'no spot yet — call them') ||
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
