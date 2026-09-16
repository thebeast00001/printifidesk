-- Printifi — 0037: a payment through Printifi is heard on both sides.
--
-- Run after 0036.
--
-- gateway_paid() (0032) moves a paid order from placed to queued by itself —
-- the money is in, there is nothing for the desk to check — but it did so
-- in silence. The desk's push fires when the order is *placed* (still
-- unpaid: "New order"), and the student's queued push said "in the queue"
-- with no word about the money. So on the desk, an order left New and
-- nothing announced why. Two things:
--
-- 1. The desk is pushed the moment a payment lands — "Paid online · B12 ·
--    ₹28 · 10 pages — in the queue" — to the same devices the new-order push
--    reaches. The server drains the queue right after marking the order,
--    so this is seconds, not the next cron.
-- 2. The student's queued push says the payment was taken, when it was:
--    "Paid ₹28 online — order B12 is in the queue at Desk."
--
-- Both are new rows in `notifications`; the dispatcher (already in place)
-- sends them. Nothing else changes.

-- ============================================================
-- 1. The desk hears the payment
-- ============================================================
create or replace function public.queue_desk_paid_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  op  public.operators;
  msg text;
begin
  -- Only the moment it becomes paid; a retry that changes nothing is quiet.
  if old.gateway_paid_at is not null or new.gateway_paid_at is null then
    return new;
  end if;

  select * into op from public.operators where id = new.operator_id;

  msg := 'Paid online · ' || coalesce(new.token, '') || ' · ' || coalesce(op.currency, '₹')
      || case when new.total = trunc(new.total)
              then trim(to_char(new.total, 'FM999999990'))
              else trim(to_char(new.total, 'FM999999990.00')) end
      || ' · ' || new.pages || ' page' || case when new.pages = 1 then '' else 's' end
      || case when new.colour_pages > 0 then ', ' || new.colour_pages || ' colour' else '' end
      || ' — in the queue';

  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail, audience)
  select s.user_id, new.id, 'push', null, msg, 'queued', null, 'desk'
    from public.staff s
   where s.operator_id = new.operator_id
     and exists (select 1 from public.push_subscriptions p where p.user_id = s.user_id and p.desk);

  return new;
end;
$$;

drop trigger if exists orders_queue_desk_paid_notification on public.orders;
create trigger orders_queue_desk_paid_notification
  after update of gateway_paid_at on public.orders
  for each row execute function public.queue_desk_paid_notification();

-- ============================================================
-- 2. The student's push names the payment
-- ============================================================
-- Same function as 0011, one line different: a queued event whose note is
-- gateway_paid()'s own wording leads with the amount. The note is read from
-- the event row, not the order — this fires inside the order's BEFORE
-- trigger, when the order row on disk is still the unpaid one.
create or replace function public.queue_order_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ord  public.orders;
  prof public.profiles;
  op   public.operators;
  msg  text;
  amt  text;
begin
  if new.status not in ('queued', 'ready', 'failed', 'collected') then
    return new;
  end if;

  select * into ord from public.orders where id = new.order_id;
  if ord.id is null or ord.user_id is null then
    return new;
  end if;

  select * into prof from public.profiles  where id = ord.user_id;
  select * into op   from public.operators where id = ord.operator_id;

  amt := coalesce(op.currency, '₹')
      || case when ord.total = trunc(ord.total)
              then trim(to_char(ord.total, 'FM999999990'))
              else trim(to_char(ord.total, 'FM999999990.00')) end;

  msg := case new.status
    when 'queued'    then case when new.note like 'Paid online through Printifi%'
                            then 'Paid ' || amt || ' online — order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '.'
                            else 'Order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '.'
                          end
    when 'ready'     then 'Ready to collect. Show token ' || coalesce(ord.token, '') || ' at ' ||
                          coalesce(op.short_name, op.name, 'Printifi') || '.'
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
