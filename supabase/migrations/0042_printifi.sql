-- 0042: the name, spelled the way the address is.
--
-- The product is Printifi — the spelling on the domain, the standee and the
-- search box. Every message the database writes or raises named it the old
-- way; these are the same functions as before, from their latest definitions
-- (0015 → 0039), with the one word changed. Nothing about what they check or
-- write moves. `create or replace` keeps each function's grants.
--
-- Run after 0041. Safe to run again.

begin;

-- from 0032_gateway.sql
-- Grants keep browsers out; this keeps them out twice. Supabase's service
-- key carries role = service_role and no sub; a Clerk token carries a sub.
create or replace function public.assert_server()
returns void language plpgsql stable as $$
begin
  -- A direct connection (no claims at all) is an operator at the console;
  -- anything through the API must be the service role, with no Clerk sub.
  if public.clerk_id() is not null
     or (auth.jwt() is not null and coalesce(auth.jwt() ->> 'role', '') <> 'service_role') then
    raise exception 'Only Printifi''s server may do this';
  end if;
end;
$$;

-- from 0032_gateway.sql
create or replace function public.gateway_paid(
  p_order uuid, p_payment_id text, p_amount numeric, p_group text, p_paid_at timestamptz
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  o public.orders;
begin
  perform public.assert_server();
  select * into o from public.orders where id = p_order for update;
  if o.id is null then
    raise exception 'No such order';
  end if;
  -- Cashfree retries webhooks and the status poll can race them: the
  -- second arrival is a no-op, not a second payment.
  if o.gateway_paid_at is not null then
    return false;
  end if;
  if p_amount is null or p_amount < o.total then
    raise exception 'Paid % of a % bill', p_amount, o.total;
  end if;
  perform set_config('printify.gateway', '1', true);
  update public.orders
     set payment_method     = 'gateway',
         payment_claimed_at = coalesce(payment_claimed_at, p_paid_at),
         payment_taken_at   = coalesce(payment_taken_at, p_paid_at),
         payment_received   = p_amount,
         payment_reference  = coalesce(payment_reference, p_payment_id),
         gateway_payment_id = p_payment_id,
         gateway_paid_at    = p_paid_at,
         fee_settled_at     = p_paid_at,
         -- Paid is accepted: the desk has nothing to check.
         status = case when status = 'placed' then 'queued' else status end,
         note   = case when status = 'placed'
                       then 'Paid online through Printifi (' || coalesce(p_group, 'gateway') || ')'
                       else note end
   where id = p_order;
  return true;
end;
$$;

-- from 0032_gateway.sql
create or replace function public.gateway_refunded(
  p_order uuid, p_refund_id text, p_amount numeric, p_note text
) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_server();
  if p_amount is null or p_amount <= 0 then
    raise exception 'A refund is more than nothing';
  end if;
  perform set_config('printify.gateway', '1', true);
  update public.orders
     set refunded_at       = coalesce(refunded_at, now()),
         refund_amount     = p_amount,
         refund_note       = p_note,
         gateway_refund_id = p_refund_id
   where id = p_order and gateway_payment_id is not null;
  if not found then
    raise exception 'That order was not paid through Printifi';
  end if;
end;
$$;

-- from 0025_fee_lock.sql
/**
 * Opening a desk with an overdue fee is refused; closing is always allowed.
 * The check runs as the trigger's owner so it doesn't depend on who flips
 * the switch — the sentence is the same for everyone.
 */
create or replace function public.guard_fee_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  st record;
begin
  if new.is_open and not old.is_open then
    select f.due, f.due_month, f.overdue into st
      from public.fee_status(new.id) f;
    if st.overdue then
      raise exception 'Printifi fee for % is overdue (₹%). Settle it from Takings to open again.',
        to_char(st.due_month, 'Month YYYY'), trim(to_char(st.due, 'FM999999990.00'))
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

-- from 0026_shut_desk.sql
/** Returns how many orders are still live, so the admin knows what the desk is left holding. */
create or replace function public.shut_operator(p_operator uuid, p_reason text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  reason text := nullif(trim(coalesce(p_reason, '')), '');
  live   bigint;
begin
  if not public.is_admin() then
    raise exception 'Only the admin can shut a desk';
  end if;
  if reason is null then
    raise exception 'Say why the desk is being shut — it is kept with the desk';
  end if;
  if length(reason) > 500 then
    raise exception 'Keep the reason under five hundred characters';
  end if;
  if not exists (select 1 from public.operators where id = p_operator) then
    raise exception 'No such desk';
  end if;

  update public.operators
     set shut_at     = coalesce(shut_at, now()),
         shut_reason = reason,
         shut_by     = public.clerk_id(),
         is_listed   = false,
         is_open     = false,
         status_note = 'Closed by Printifi'
   where id = p_operator;

  update public.staff_invites i
     set revoked_at = now()
   where i.operator_id = p_operator
     and i.claimed_at is null and i.revoked_at is null;

  select count(*) into live
    from public.orders o
   where o.operator_id = p_operator
     and o.status not in ('collected', 'cancelled');
  return live;
end;
$$;

-- from 0036_lockdown.sql
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

-- from 0026_shut_desk.sql
/** No new codes and no new staff for a shut desk — whoever is asking. */
create or replace function public.guard_shut_desk_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.operators o where o.id = new.operator_id and o.shut_at is not null) then
    raise exception 'This desk was closed by Printifi' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- from 0015_desk_tools.sql
-- A message is worth a push. Same queue, same dispatcher, same honesty about
-- whether it was delivered.
create or replace function public.queue_message_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ord  public.orders;
  prof public.profiles;
  op   public.operators;
  msg  text;
begin
  select * into ord from public.orders where id = new.order_id;
  if ord.id is null or ord.user_id is null then return new; end if;

  select * into prof from public.profiles  where id = ord.user_id;
  select * into op   from public.operators where id = ord.operator_id;

  msg := coalesce(op.short_name, op.name, 'Printifi') || ' about order '
      || coalesce(ord.token, '') || ': ' || new.body;

  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail)
  values (
    ord.user_id, new.order_id, 'push', null, msg,
    case
      when coalesce(prof.notify_push, true) = false then 'skipped'
      when not exists (select 1 from public.push_subscriptions s where s.user_id = ord.user_id) then 'skipped'
      else 'queued'
    end,
    case
      when coalesce(prof.notify_push, true) = false then 'turned off in settings'
      when not exists (select 1 from public.push_subscriptions s where s.user_id = ord.user_id) then 'no device subscribed'
      else null
    end
  );

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

  return new;
end;
$$;

-- from 0039_shop_ready.sql
create or replace function public.add_staff(p_operator uuid, p_email text, p_role text default 'staff')
returns text language plpgsql security definer set search_path = public as $$
declare
  target text;
begin
  if not public.is_owner(p_operator) then
    raise exception 'Only the desk''s owner adds staff';
  end if;
  if coalesce(p_role, 'staff') not in ('owner', 'staff') then
    raise exception 'A person is an owner or staff';
  end if;

  select id into target from public.profiles
   where lower(email) = lower(trim(p_email))
   limit 1;

  if target is null then
    raise exception 'No Printifi account with that email. They need to sign in once first.';
  end if;

  insert into public.staff (user_id, operator_id, role)
  values (target, p_operator, coalesce(p_role, 'staff'))
  on conflict do nothing;

  return target;
end;
$$;

-- from 0039_shop_ready.sql
/** The desk proposes corrected counts; nothing on the order changes until the student accepts. */
create or replace function public.propose_requote(p_order uuid, p_items jsonb, p_note text)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  o    public.orders;
  r    record;
  why  text := nullif(trim(coalesce(p_note, '')), '');
  op   public.operators;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'No such order'; end if;
  if not public.is_staff(o.operator_id) then raise exception 'Not your desk'; end if;
  if o.status <> 'placed' then
    raise exception 'A bill is corrected before the order is accepted';
  end if;
  if o.payment_taken_at is not null or o.gateway_paid_at is not null then
    raise exception 'This order is paid — the bill stands; take any difference in cash at the counter';
  end if;
  if why is null or length(why) > 120 then
    raise exception 'Say why, in up to 120 characters';
  end if;

  select * into r from public.reprice_order(p_order, p_items);
  if r.total = o.total and r.pages = o.pages and r.colour_pages = o.colour_pages then
    raise exception 'That''s the same bill';
  end if;

  perform set_config('printify.gateway', '1', true);
  update public.orders
     set requote = jsonb_build_object(
           'from', o.total, 'total', r.total, 'platform_fee', r.platform_fee, 'rounding', r.rounding,
           'pages', r.pages, 'colour_pages', r.colour_pages, 'lines', r.lines,
           'note', why, 'by', public.clerk_id(), 'at', now()),
         requote_status = 'proposed'
   where id = p_order;

  insert into public.order_events (order_id, status, actor, note)
  values (p_order, o.status, public.clerk_id(),
          'Bill corrected to ' || trim(to_char(r.total, 'FM999999990.00')) || ' — ' || why || ' — waiting for you to accept');

  select * into op from public.operators where id = o.operator_id;
  perform public.notify_student(o.user_id, p_order,
    coalesce(op.short_name, op.name, 'The desk') || ' corrected order ' || coalesce(o.token, '') || ' to '
    || coalesce(op.currency, '₹') || trim(to_char(r.total, 'FM999999990.00')) || ' (' || why || '). Open Printifi to accept it.');

  return r.total;
end;
$$;

-- from 0039_shop_ready.sql
--    and no accepting past a correction that's waiting
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
    if new.status = 'queued' and old.status <> 'queued' then
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

-- from 0039_shop_ready.sql
-- The student hears about the two new endings.
create or replace function public.queue_order_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ord  public.orders;
  prof public.profiles;
  op   public.operators;
  msg  text;
  amt  text;
begin
  if new.status not in ('queued', 'ready', 'failed', 'collected', 'unclaimed', 'cancelled') then
    return new;
  end if;

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

  msg := case new.status
    when 'queued'    then case when new.note like 'Paid online through Printif%'
                            then 'Paid ' || amt || ' online — order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '.'
                            else 'Order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '.'
                          end
    when 'ready'     then 'Ready to collect. Show token ' || coalesce(ord.token, '') || ' at ' ||
                          coalesce(op.short_name, op.name, 'Printifi') || '.'
    when 'collected' then 'Collected. Thanks!'
    when 'unclaimed' then 'Order ' || coalesce(ord.token, '') || ' wasn''t collected and has been cleared from the shelf at ' ||
                          coalesce(op.short_name, op.name, 'Printifi') || '. Ask at the counter if you still need it.'
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

  return new;
end;
$$;

-- A desk closed by the platform carries the reason on its row; the words
-- say who closed it.
update public.operators
   set status_note = replace(status_note, 'Closed by Printify', 'Closed by Printifi')
 where status_note like '%Closed by Printify%';

commit;
