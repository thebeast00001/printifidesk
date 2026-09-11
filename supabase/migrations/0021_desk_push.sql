-- Print Counter — new-order pushes to the desk.
--
-- Run after 0020.
--
-- The desk site installs as its own app, and an installed app that's been
-- closed should still buzz when an order lands. Until now the only alert
-- was a chime in an open tab. Same queue, same dispatcher, same honesty
-- about what was and wasn't sent; two additions:
--
--   * push_subscriptions.desk — this device subscribed from the desk site
--     and wants the desk's alerts. A student's "ready" push still goes to
--     every device the student has; a desk push goes only to desk devices.
--   * notifications.audience — who a row is for, so the dispatcher knows
--     which subscriptions to pick and what to put on the notification.

alter table public.push_subscriptions
  add column if not exists desk boolean not null default false;

alter table public.notifications
  add column if not exists audience text not null default 'student';

do $$ begin
  alter table public.notifications add constraint notifications_audience_valid
    check (audience in ('student', 'desk'));
exception when duplicate_object then null;
end $$;

/**
 * One push row per staff member with a desk device, the moment an order is
 * inserted. `place_order()` sets the total before the insert and the token
 * trigger runs before this one, so both are on the row already. Staff with
 * no desk device get no row at all — five "skipped" lines per order would
 * be noise, not a record.
 */
create or replace function public.queue_desk_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  op  public.operators;
  msg text;
begin
  select * into op from public.operators where id = new.operator_id;

  msg := 'New order ' || coalesce(new.token, '') || ' — ' || new.pages || ' page'
      || case when new.pages = 1 then '' else 's' end
      || case when new.colour_pages > 0 then ', ' || new.colour_pages || ' colour' else '' end
      || ', ' || coalesce(op.currency, '₹')
      -- Whole rupees read as "28", paise as "28.50" — the same rule money() uses.
      || case when new.total = trunc(new.total)
              then trim(to_char(new.total, 'FM999999990'))
              else trim(to_char(new.total, 'FM999999990.00')) end
      || case when new.pickup_at is not null then ' · scheduled' else '' end;

  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail, audience)
  select s.user_id, new.id, 'push', null, msg, 'queued', null, 'desk'
    from public.staff s
   where s.operator_id = new.operator_id
     and exists (select 1 from public.push_subscriptions p where p.user_id = s.user_id and p.desk);

  return new;
end;
$$;

drop trigger if exists orders_queue_desk_notification on public.orders;
create trigger orders_queue_desk_notification
  after insert on public.orders
  for each row execute function public.queue_desk_notification();
