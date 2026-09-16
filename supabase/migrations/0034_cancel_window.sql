-- Print Counter — a cancel is refused in words once the desk has started.
--
-- Run after 0033.
--
-- The "orders cancel" policy (0001) only lets a student's update reach a
-- row that is still 'placed' or 'queued'; anything later is invisible to
-- the update and PostgREST reports nothing changed. The app now says why.
-- The guard says it too, so a superuser path (the harness, a console)
-- refuses the same way the policy does, and the two never disagree.

create or replace function public.guard_order_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Printifi's own server, inside gateway_begin / gateway_paid /
  -- gateway_refunded. The flag is transaction-local and set nowhere else.
  if current_setting('printify.gateway', true) = '1' then
    return new;
  end if;

  if public.is_staff(new.operator_id) then
    if new.status = 'queued' and old.status <> 'queued' then
      new.payment_taken_at := coalesce(new.payment_taken_at, now());
      -- What the desk saw arrive. Left unsaid, it is the bill: a desk that
      -- taps Confirm without a number is saying the money was right.
      new.payment_received := coalesce(new.payment_received, new.total);
    end if;
    if new.payment_received is not null and new.payment_received < 0 then
      raise exception 'The amount received cannot be negative';
    end if;
    -- The gateway's facts are the server's, not the desk's either.
    new.gateway_order_id   := old.gateway_order_id;
    new.gateway_payment_id := old.gateway_payment_id;
    new.gateway_paid_at    := old.gateway_paid_at;
    new.fee_settled_at     := old.fee_settled_at;
    new.gateway_refund_id  := old.gateway_refund_id;
    return new;
  end if;

  new.operator_id       := old.operator_id;
  new.user_id           := old.user_id;
  new.token             := old.token;
  new.handover_code     := old.handover_code;
  new.rate_card         := old.rate_card;
  new.total             := old.total;
  new.full_colour_total := old.full_colour_total;
  new.platform_fee      := old.platform_fee;
  new.rounding          := old.rounding;
  new.payment_received  := old.payment_received;
  new.shortfall_cleared_at := old.shortfall_cleared_at;
  new.shelf_slot        := old.shelf_slot;
  new.gateway_order_id   := old.gateway_order_id;
  new.gateway_payment_id := old.gateway_payment_id;
  new.gateway_paid_at    := old.gateway_paid_at;
  new.fee_settled_at     := old.fee_settled_at;
  new.gateway_refund_id  := old.gateway_refund_id;
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
    new.payment_reference      := old.payment_reference;
    new.payment_claimed_amount := old.payment_claimed_amount;
  end if;
  if new.payment_claimed_amount is not null
     and (new.payment_claimed_amount < 0 or new.payment_claimed_amount > 100000) then
    raise exception 'That amount is out of range';
  end if;

  if new.status is distinct from old.status then
    if new.status <> 'cancelled' then
      raise exception 'You can only cancel this order';
    end if;
    -- The policy already hides a row past 'queued' from the student's
    -- update; the guard says so in words as well, so the refusal is the
    -- same whichever layer catches it.
    if old.status not in ('placed', 'queued') then
      raise exception 'Too late to cancel — the desk has started on it. Ask at the counter.';
    end if;
    new.cancelled_by := 'student';
  end if;

  return new;
end;
$$;
