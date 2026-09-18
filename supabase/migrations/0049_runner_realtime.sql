-- 0049: the runner's list moves the moment a desk files a job.
--
-- Run after 0048.
--
-- A runner isn't the owner or the desk of any order, so the orders socket
-- says nothing to them, and the runner's page read its list again every
-- fifteen seconds. Every event a runner should act on already writes them
-- a notification row — a delivery filed on a shelf, a student who moved —
-- and a runner can read their own rows. So the notifications table joins
-- the realtime publication, the runner's page listens for its own rows,
-- and the row is written whether or not the runner has a device to push
-- to: 'skipped' with the reason, the way set_delivery_spot() writes it,
-- rather than not at all. The insert is the signal; the push is a bonus.

begin;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

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

  -- A delivery job filed on a shelf: every active runner hears where to
  -- go — a push where they have a desk device, and the row either way,
  -- because the row is what moves their list (0049). Not when a runner has
  -- just brought it back — they know.
  if new.status = 'ready' and coalesce(ord.delivery, false) and coalesce(new.note, '') not like 'Couldn''t deliver%' then
    insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail, audience)
    select r.user_id, new.order_id, 'push', null,
           'Delivery ready at ' || coalesce(op.short_name, op.name, 'a desk') || ': ' || coalesce(ord.token, '') ||
           ' → ' || coalesce(dest, 'no spot yet — call them') ||
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
