-- Print Counter — the student's QR proves it's theirs.
--
-- Run after 0015.
--
-- The token is sequential and printed on every slip on the shelf, so a QR
-- that carries only the token is a QR anyone can make. The student's code now
-- also carries a per-order secret nobody but the student (and the desk) can
-- read; the slip's code does not. A scan of a student's phone is then proof;
-- a scan of a slip, or a typed token, is only a lookup.

-- ============================================================
-- 1. A secret per order
-- ============================================================
alter table public.orders add column if not exists handover_code text;

/**
 * Eight hex characters from a v4 UUID: four billion possibilities, and a
 * scanner that only ever compares, never enumerates. Set by the same trigger
 * moment as the token, so an order never exists without one.
 */
create or replace function public.assign_handover_code()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.handover_code is null then
    new.handover_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  end if;
  return new;
end;
$$;

drop trigger if exists orders_assign_handover_code on public.orders;
create trigger orders_assign_handover_code
  before insert on public.orders
  for each row execute function public.assign_handover_code();

-- Live orders placed before this migration get one now, so their students'
-- codes verify from the next reload.
update public.orders
   set handover_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
 where handover_code is null;

-- ============================================================
-- 2. Nothing but the trigger may set it
-- ============================================================
-- The guard from 0012, with the new column pinned. A student who could write
-- their own code could write a known one and hand the QR around; a student
-- who could clear it would make their order unverifiable, which is worse for
-- them than for anyone else — but pinned is pinned.
create or replace function public.guard_order_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Staff run the queue; they're allowed everything.
  if public.is_staff(new.operator_id) then
    if new.status = 'queued' and old.status <> 'queued' then
      new.payment_taken_at := coalesce(new.payment_taken_at, now());
    end if;
    return new;
  end if;

  -- Anyone else may only cancel, or record that they've paid.
  new.operator_id       := old.operator_id;
  new.user_id           := old.user_id;
  new.token             := old.token;
  new.handover_code     := old.handover_code;
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

  -- The UPI reference is the student's to give, but only until the operator
  -- has checked it. After that it's evidence.
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

-- ============================================================
-- 3. Token uniqueness as a constraint, not a hope
-- ============================================================
-- `assign_order_token()` hands out distinct numbers because Postgres
-- serialises the upsert on one row per desk per day. That has always held.
-- This makes it impossible for it to silently stop holding: two orders at one
-- desk on one day with the same token is now a refused insert, not a shelf
-- with two A03s on it.
create unique index if not exists orders_token_unique_per_day
  on public.orders (operator_id, ((created_at at time zone 'UTC')::date), token)
  where token is not null;
