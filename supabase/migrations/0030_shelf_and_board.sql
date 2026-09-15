-- Print Counter — a slot on the shelf, and a board on the wall.
--
-- Run after 0029.
--
-- Shelf: a shop with thirty packets waiting finds the right one slowly.
-- A desk that sets shelf_rows (A..H) × shelf_cols (1..20) gets every job
-- a slot the moment it's marked ready — the lowest one no *ready* job at
-- that desk holds. It's printed on the slip, shown to the student, and
-- freed the moment the job leaves 'ready' (collected, or anything else),
-- because the in-use set is "ready jobs' slots", nothing more. The desk
-- can overwrite a slot by hand; the student can't touch it.
--
-- Board: a screen at the counter showing tokens in the queue, printing
-- and ready — no names, no files. board() is security definer and open to
-- anon: a token is already on every slip on the shelf, and the shelf is
-- what the screen replaces. Shut desks show nothing.

alter table public.operators add column if not exists shelf_rows integer not null default 0
  check (shelf_rows between 0 and 8);
alter table public.operators add column if not exists shelf_cols integer not null default 9
  check (shelf_cols between 1 and 20);
alter table public.orders add column if not exists shelf_slot text
  check (shelf_slot is null or shelf_slot ~ '^[A-H][0-9]{1,2}$');

-- ============================================================
-- 1. The slot, assigned on 'ready'
-- ============================================================
create or replace function public.assign_shelf_slot()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rows_n integer;
  cols_n integer;
  free   text;
begin
  -- Only the transition into 'ready', and only if nobody named a slot.
  if new.status <> 'ready' or old.status = 'ready' or new.shelf_slot is not null then
    return new;
  end if;
  select o.shelf_rows, o.shelf_cols into rows_n, cols_n
    from public.operators o where o.id = new.operator_id;
  if coalesce(rows_n, 0) = 0 then
    return new;
  end if;
  select s.slot into free
    from (select chr(64 + r) || c::text as slot, r, c
            from generate_series(1, rows_n) r, generate_series(1, cols_n) c) s
   where not exists (
           select 1 from public.orders q
            where q.operator_id = new.operator_id
              and q.status = 'ready'
              and q.shelf_slot = s.slot
              and q.id <> new.id)
   order by s.r, s.c
   limit 1;
  -- Every slot taken: the job is still ready, just without a slot; the
  -- card says so and the desk can type one when a packet leaves.
  new.shelf_slot := free;
  return new;
end;
$$;

-- After the guard (orders_guard_update) and the event recorder
-- (orders_record_update): triggers on one event fire in name order.
drop trigger if exists orders_shelf_slot on public.orders;
create trigger orders_shelf_slot
  before update of status on public.orders
  for each row execute function public.assign_shelf_slot();

-- ============================================================
-- 2. The board
-- ============================================================
drop function if exists public.board(uuid);
create function public.board(p_operator uuid)
returns table (token text, status text, shelf_slot text, since timestamptz)
language sql stable security definer set search_path = public as $$
  select o.token, o.status, o.shelf_slot,
         coalesce(case o.status when 'ready' then o.ready_at
                                when 'printing' then o.started_at
                                else o.accepted_at end, o.created_at)
    from public.orders o
    join public.operators op on op.id = o.operator_id
   where o.operator_id = p_operator
     and op.shut_at is null
     and o.status in ('queued', 'printing', 'finishing', 'ready')
   order by case o.status when 'ready' then 0 when 'finishing' then 1 when 'printing' then 2 else 3 end,
            o.is_priority desc, o.created_at;
$$;

grant execute on function public.board(uuid) to anon, authenticated;

-- ============================================================
-- 3. The guard pins the slot against the student
-- ============================================================
create or replace function public.guard_order_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
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
    new.cancelled_by := 'student';
  end if;

  return new;
end;
$$;
