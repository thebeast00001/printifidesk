-- Print Counter — paying by UPI, without a gateway.
--
-- Money goes straight from the student to the operator's own UPI id. There is
-- no merchant account, no percentage, and nothing sits in the middle — which
-- also means Printifi never holds anyone's money.
--
-- The honest limit: without a gateway webhook nothing here can *verify* a
-- payment. The student can record that they've paid; only the operator, looking
-- at their own UPI app, confirms it. Every column below is named for which of
-- those two things it is.
--
-- Run after 0008.

alter table public.operators add column if not exists upi_vpa      text;
alter table public.operators add column if not exists upi_name     text;
alter table public.operators add column if not exists accepts_cash boolean not null default true;

-- 'upi' or 'cash' — what the student said they'd do, set when they claim.
alter table public.orders add column if not exists payment_method     text;
-- When the student said they paid. NOT proof, and never rendered as proof.
alter table public.orders add column if not exists payment_claimed_at timestamptz;
-- When the operator confirmed it against their own records. This is the truth.
alter table public.orders add column if not exists payment_taken_at   timestamptz;

do $$ begin
  alter table public.orders add constraint orders_payment_method_valid
    check (payment_method is null or payment_method in ('upi', 'cash'));
exception when duplicate_object then null;
end $$;

-- ============================================================
-- Stop a student editing anything but their own two decisions
-- ============================================================
-- The update policy from 0001 lets the owner update the row while it's still
-- 'placed' or 'queued'. RLS can't restrict *columns*, so as written a student
-- could rewrite `total` and pay themselves a discount. This trigger pins every
-- field they have no business touching back to its old value.
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

  if new.status is distinct from old.status then
    if new.status <> 'cancelled' then
      raise exception 'You can only cancel this order';
    end if;
    new.cancelled_by := 'student';
  end if;

  return new;
end;
$$;

-- Fires before orders_record_update (triggers run in name order), so the
-- timeline records the values that actually survived the guard.
drop trigger if exists orders_guard_update on public.orders;
create trigger orders_guard_update
  before update on public.orders
  for each row execute function public.guard_order_update();

-- ============================================================
-- What the operator sees on the queue
-- ============================================================
comment on column public.orders.payment_claimed_at is
  'When the student said they paid. A claim, not a confirmation.';
comment on column public.orders.payment_taken_at is
  'When the operator confirmed the money arrived. This is the authoritative one.';
