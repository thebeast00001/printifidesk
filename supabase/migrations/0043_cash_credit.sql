-- 0043: cash is a credit line, the desk is covered, the student settles.
--
-- Run after 0042.
--
-- The desks' objection, word for word: most students pay cash, and with
-- WhatsApp orders four in ten never come for what was printed. The shop
-- had been extending credit to strangers one job at a time. This makes the
-- credit explicit, bounded and earned — and moves the loss off the desk.
--
--   Every order prints the moment it's placed. No waiting at the counter.
--
--   Cash is allowed within a limit that starts small (₹50) and grows with
--   every cash order collected (+₹25 each, to ₹300); one open cash order at
--   a time; nothing at all while dues are unpaid. Above the limit, cash is
--   still allowed — but the desk prints when the student taps "Leaving now"
--   rather than blind.
--
--   An in-limit cash order that isn't collected is marked unclaimed by the
--   sweep, as before. Now it also: adds the bill to the student's dues, adds
--   a strike (the second locks cash for a season), and credits the desk its
--   price for the job — a desk_credits row that lands in the desk's payout
--   (collect mode) or against its platform fee (direct mode). The desk
--   cannot lose money on a Printifi order.
--
--   Dues are settled by the student online (Printifi's gateway, a
--   dues_payments row) or in cash at any desk, which then owes Printifi the
--   cash it took (a negative desk_credits row). Until settled, place_order
--   refuses — at every desk.
--
--   The platform fee is not charged on an order nobody paid for.
--
-- Every number is a platform setting the admin can change; the defaults
-- are the ones in the pitch.

begin;

-- ============================================================
-- 1. Columns and tables
-- ============================================================
alter table public.platform_settings
  add column if not exists cash_limit_start     numeric(10,2) not null default 50  check (cash_limit_start >= 0),
  add column if not exists cash_limit_step      numeric(10,2) not null default 25  check (cash_limit_step >= 0),
  add column if not exists cash_limit_cap       numeric(10,2) not null default 300 check (cash_limit_cap >= 0),
  add column if not exists cash_strikes_allowed integer       not null default 2   check (cash_strikes_allowed between 1 and 10),
  add column if not exists cash_lockout_days    integer       not null default 120 check (cash_lockout_days between 1 and 365);

alter table public.profiles
  add column if not exists dues               numeric(10,2) not null default 0 check (dues >= 0),
  add column if not exists cash_collected     integer       not null default 0,
  add column if not exists cash_strikes       integer       not null default 0,
  add column if not exists cash_blocked_until timestamptz;

alter table public.orders
  -- Cash, taken when the student collects; the order was printed on credit.
  add column if not exists pay_at_pickup   boolean not null default false,
  -- Above the student's limit: the desk prints when the student says they're leaving.
  add column if not exists print_on_signal boolean not null default false,
  add column if not exists signalled_at    timestamptz,
  -- Unclaimed and unpaid: the desk was credited this much, then.
  add column if not exists covered_at      timestamptz,
  add column if not exists covered_amount  numeric(10,2),
  -- The "still waiting" nudge, sent once.
  add column if not exists reminded_at     timestamptz;

-- What Printifi owes a desk (positive) or a desk owes Printifi (negative),
-- outside the orders themselves: a covered uncollected order, cash taken
-- for someone's dues. Each row lands in one ledger, fixed when it's made.
create table if not exists public.desk_credits (
  id          bigserial primary key,
  operator_id uuid not null references public.operators on delete cascade,
  order_id    uuid references public.orders on delete set null,
  user_id     text not null,
  amount      numeric(10,2) not null check (amount <> 0),
  kind        text not null check (kind in ('unclaimed', 'dues_cash')),
  applied_to  text not null check (applied_to in ('payout', 'fee')),
  note        text,
  recorded_by text,
  created_at  timestamptz not null default now()
);
create index if not exists desk_credits_operator on public.desk_credits (operator_id, created_at desc);
create index if not exists desk_credits_user on public.desk_credits (user_id, created_at desc);
alter table public.desk_credits enable row level security;
drop policy if exists "credits read" on public.desk_credits;
create policy "credits read" on public.desk_credits for select
  using (public.is_owner(operator_id) or public.is_admin() or user_id = public.clerk_id());
-- Writes go through the functions below only.

-- A student paying dues through Printifi: one row per attempt, marked when
-- Cashfree says it was paid.
create table if not exists public.dues_payments (
  id                 uuid primary key default gen_random_uuid(),
  user_id            text not null,
  amount             numeric(10,2) not null check (amount > 0),
  gateway_order_id   text not null unique,
  gateway_payment_id text,
  paid_at            timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists dues_payments_user on public.dues_payments (user_id, created_at desc);
alter table public.dues_payments enable row level security;
drop policy if exists "dues payments own read" on public.dues_payments;
create policy "dues payments own read" on public.dues_payments for select
  using (user_id = public.clerk_id() or public.is_admin());

-- ============================================================
-- 2. A student's cash standing
-- ============================================================
/** Whether the order's bill was ever paid — at the counter, or through Printifi. */
create or replace function public.order_paid(o public.orders)
returns boolean language sql immutable as $$
  select o.payment_taken_at is not null or o.gateway_paid_at is not null
$$;

/** The cash limit a student has earned: the start, plus a step per cash order collected, capped. */
create or replace function public.cash_limit_of(p_user text)
returns numeric language sql stable security definer set search_path = public as $$
  select least(s.cash_limit_cap, s.cash_limit_start + s.cash_limit_step * coalesce(p.cash_collected, 0))::numeric
    from public.platform_settings s
    left join public.profiles p on p.id = p_user
   where s.id
$$;

/**
 * Where a student stands with cash: dues, limit, strikes, the one open cash
 * order if any, and whether cash can be chosen right now — with the reason
 * when it can't. A student's own; a desk's staff and the admin, anyone's.
 */
drop function if exists public.cash_standing(text);
create or replace function public.cash_standing(p_user text default null)
returns table (
  dues numeric, cash_limit numeric, strikes integer, collected integer,
  blocked_until timestamptz, open_cash_order uuid, open_cash_token text,
  can_cash boolean, reason text
)
language plpgsql stable security definer set search_path = public as $$
declare
  who   text := coalesce(p_user, public.clerk_id());
  prof  public.profiles;
  lim   numeric;
  open_id uuid;
  open_tok text;
begin
  if who is null then return; end if;
  if who <> coalesce(public.clerk_id(), '') and not public.is_admin() and not public.is_server()
     and not exists (select 1 from public.staff s where s.user_id = public.clerk_id()) then
    return;
  end if;
  select * into prof from public.profiles where id = who;
  lim := public.cash_limit_of(who);
  select o.id, o.token into open_id, open_tok
    from public.orders o
   where o.user_id = who and o.pay_at_pickup and o.payment_taken_at is null and o.gateway_paid_at is null
     and o.status in ('placed', 'queued', 'printing', 'finishing', 'ready')
   order by o.created_at limit 1;
  return query select
    coalesce(prof.dues, 0)::numeric,
    lim,
    coalesce(prof.cash_strikes, 0),
    coalesce(prof.cash_collected, 0),
    prof.cash_blocked_until,
    open_id,
    open_tok,
    coalesce(prof.dues, 0) = 0
      and (prof.cash_blocked_until is null or prof.cash_blocked_until < now())
      and open_id is null,
    case
      when coalesce(prof.dues, 0) > 0 then 'dues'
      when prof.cash_blocked_until is not null and prof.cash_blocked_until >= now() then 'blocked'
      when open_id is not null then 'open'
      else null
    end;
end;
$$;

-- ============================================================
-- 3. Choosing cash; saying you're leaving
-- ============================================================
/**
 * The student chooses cash for an order. Within their limit the order goes
 * straight into the queue and is paid when collected; above it, the desk
 * waits for "Leaving now" before printing. Returns 'queued' or 'signal'.
 */
create or replace function public.choose_cash(p_order uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  o    public.orders;
  op   public.operators;
  st   record;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null or o.user_id <> coalesce(public.clerk_id(), '') then
    raise exception 'Not your order';
  end if;
  if o.status <> 'placed' then raise exception 'This order isn''t waiting for payment'; end if;
  if o.gateway_paid_at is not null or o.payment_taken_at is not null then raise exception 'This order is already paid'; end if;
  if o.requote_status = 'proposed' then raise exception 'The desk corrected this bill — accept the new price first'; end if;
  select * into op from public.operators where id = o.operator_id;
  if op.accepts_cash = false then raise exception 'This desk doesn''t take cash'; end if;

  select * into st from public.cash_standing(o.user_id);
  if st.dues > 0 then
    raise exception 'You have ₹% due from an uncollected order. Pay it to order again.', trim(to_char(st.dues, 'FM999999990.00'));
  end if;
  if st.blocked_until is not null and st.blocked_until >= now() then
    raise exception 'Cash is off for your account until % — pay online for now.', to_char(st.blocked_until at time zone coalesce(op.tz, 'Asia/Kolkata'), 'DD Mon');
  end if;
  if st.open_cash_order is not null and st.open_cash_order <> o.id then
    raise exception 'Collect your other cash order (%) first — one at a time.', coalesce(st.open_cash_token, '');
  end if;

  perform set_config('printify.gateway', '1', true);
  if o.total <= st.cash_limit then
    -- The note rides on the 'queued' event, which is how the message that
    -- goes out knows to say what's owed at the counter.
    update public.orders
       set payment_method = 'cash', payment_claimed_at = now(), pay_at_pickup = true,
           print_on_signal = false, note = 'Cash at the counter when you collect', status = 'queued'
     where id = o.id;
    return 'queued';
  end if;
  update public.orders
     set payment_method = 'cash', payment_claimed_at = now(), pay_at_pickup = true,
         print_on_signal = true, note = 'Cash at the counter when you collect'
   where id = o.id;
  return 'signal';
end;
$$;

/** "Leaving now": the desk prints an above-limit cash order from here. */
create or replace function public.signal_leaving(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  o public.orders;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null or o.user_id <> coalesce(public.clerk_id(), '') then
    raise exception 'Not your order';
  end if;
  if not o.print_on_signal or o.signalled_at is not null then
    raise exception 'This order doesn''t need a signal';
  end if;
  if o.status <> 'placed' then raise exception 'This order has already started'; end if;
  perform set_config('printify.gateway', '1', true);
  update public.orders set signalled_at = now(), status = 'queued' where id = o.id;
end;
$$;

-- ============================================================
-- 4. What an order's endings do to the student and the desk
-- ============================================================
/**
 * Before an order's row changes: a cash order collected grows the limit;
 * a cash order unclaimed and unpaid becomes dues, a strike, and a credit
 * to the desk. Runs ahead of the guard (alphabetically), and marks the
 * transaction as the platform's own so the guard lets the stamps through.
 */
create or replace function public.settle_cash_ending()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s    public.platform_settings;
  op   public.operators;
  strikes integer;
  was   text := coalesce(current_setting('printify.gateway', true), '');
begin
  if new.status is not distinct from old.status then return new; end if;

  -- Handed over: the cash changed hands, and the student earned a step.
  -- The profile write carries the platform's flag for its own duration
  -- only, so the order guard still runs for the desk's update as usual.
  if new.status = 'collected' and new.pay_at_pickup and new.payment_taken_at is null and new.gateway_paid_at is null then
    new.payment_taken_at := now();
    new.payment_received := coalesce(new.payment_received, new.total);
    perform set_config('printify.gateway', '1', true);
    update public.profiles set cash_collected = cash_collected + 1 where id = new.user_id;
    perform set_config('printify.gateway', was, true);
    return new;
  end if;

  -- Unclaimed: only the platform marks it (the sweep, flagged), and only
  -- then do the consequences follow — a stray write can't fine anyone.
  if new.status = 'unclaimed' and new.pay_at_pickup
     and new.payment_taken_at is null and new.gateway_paid_at is null
     and new.covered_at is null
     and was = '1' then
    select * into s from public.platform_settings where id;
    select * into op from public.operators where id = new.operator_id;

    update public.profiles
       set dues = dues + new.total,
           cash_strikes = cash_strikes + 1
     where id = new.user_id
     returning cash_strikes into strikes;
    if strikes >= s.cash_strikes_allowed then
      update public.profiles
         set cash_blocked_until = now() + make_interval(days => s.cash_lockout_days)
       where id = new.user_id;
    end if;

    new.covered_amount := greatest(round(new.total - coalesce(new.platform_fee, 0), 2), 0);
    new.covered_at     := now();
    if new.covered_amount > 0 then
      insert into public.desk_credits (operator_id, order_id, user_id, amount, kind, applied_to, note)
      values (new.operator_id, new.id, new.user_id, new.covered_amount, 'unclaimed',
              case when op.gateway_status = 'collect' then 'payout' else 'fee' end,
              'Uncollected cash order ' || coalesce(new.token, '') || ' — covered by Printifi');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_cash_ending on public.orders;
create trigger orders_cash_ending
  before update of status on public.orders
  for each row execute function public.settle_cash_ending();

-- Nobody edits their own standing. The platform's own writes carry the flag.
create or replace function public.guard_profile_credit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('printify.gateway', true) = '1' then return new; end if;
  new.dues               := old.dues;
  new.cash_collected     := old.cash_collected;
  new.cash_strikes       := old.cash_strikes;
  new.cash_blocked_until := old.cash_blocked_until;
  return new;
end;
$$;
drop trigger if exists profiles_guard_credit on public.profiles;
create trigger profiles_guard_credit
  before update on public.profiles
  for each row execute function public.guard_profile_credit();

-- Dues close the door at every desk until they're paid.
create or replace function public.guard_order_dues()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  owed numeric;
begin
  select dues into owed from public.profiles where id = new.user_id;
  if coalesce(owed, 0) > 0 then
    raise exception 'You have ₹% due from an uncollected order. Pay it to order again.', trim(to_char(owed, 'FM999999990.00'));
  end if;
  return new;
end;
$$;
drop trigger if exists orders_guard_dues on public.orders;
create trigger orders_guard_dues
  before insert on public.orders
  for each row execute function public.guard_order_dues();

-- ============================================================
-- 5. The order guard learns the new columns
-- ============================================================
--  * the new flags are the platform's to set, never a student's or the desk's
--  * a cash-at-pickup order isn't "paid" when it's queued — it's paid when
--    it's handed over, and the handover stamps it
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
  new.pay_at_pickup      := old.pay_at_pickup;
  new.print_on_signal    := old.print_on_signal;
  new.signalled_at       := old.signalled_at;
  new.covered_at         := old.covered_at;
  new.covered_amount     := old.covered_amount;
  new.reminded_at        := old.reminded_at;

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
    -- Queued means paid — except a cash-at-pickup order, which the desk
    -- printed on the student's credit and is paid at the handover.
    if new.status = 'queued' and old.status <> 'queued' and not old.pay_at_pickup then
      new.payment_taken_at := coalesce(new.payment_taken_at, now());
      new.payment_received := coalesce(new.payment_received, new.total);
    end if;
    if new.status = 'collected' and old.status <> 'collected' and old.pay_at_pickup and old.payment_taken_at is null then
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
  -- Cash is chosen through choose_cash(), which checks the student's standing.
  if new.payment_method = 'cash' and old.payment_method is distinct from 'cash' then
    raise exception 'Cash is chosen from the pay sheet';
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

-- ============================================================
-- 6. The sweep: a nudge before the deadline, and above-limit orders
--    nobody set off for
-- ============================================================
create or replace function public.sweep_orders(p_operator uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  op public.operators;
  n  integer := 0;
  o  public.orders;
  amt text;
begin
  select * into op from public.operators where id = p_operator;
  if op.id is null then return 0; end if;
  if not (public.is_staff(p_operator) or public.is_server()) then
    raise exception 'Not your desk';
  end if;

  perform set_config('printify.gateway', '1', true);

  if op.unpaid_expiry_minutes > 0 then
    for o in
      select * from public.orders x
       where x.operator_id = p_operator and x.status = 'placed'
         and x.payment_claimed_at is null and x.gateway_paid_at is null and x.payment_taken_at is null
         and x.pickup_mode = 'asap'
         and x.created_at < now() - make_interval(mins => op.unpaid_expiry_minutes)
       for update skip locked
    loop
      update public.orders
         set status = 'cancelled', cancelled_by = 'system',
             note = 'Not paid within ' || op.unpaid_expiry_minutes || ' minutes — order again when you''re ready'
       where id = o.id;
      n := n + 1;
    end loop;
  end if;

  if op.unclaimed_after_hours > 0 then
    -- An above-limit cash order the student never set off for: nothing was
    -- printed, nothing is owed — it simply lapses.
    for o in
      select * from public.orders x
       where x.operator_id = p_operator and x.status = 'placed'
         and x.print_on_signal and x.signalled_at is null
         and coalesce(x.pickup_at, x.created_at) < now() - make_interval(hours => op.unclaimed_after_hours)
       for update skip locked
    loop
      update public.orders
         set status = 'cancelled', cancelled_by = 'system',
             note = 'You didn''t set off within ' || op.unclaimed_after_hours || ' hours — order again when you''re ready'
       where id = o.id;
      n := n + 1;
    end loop;

    -- Halfway to the deadline, one reminder — and for a cash order, what
    -- missing it costs.
    for o in
      select * from public.orders x
       where x.operator_id = p_operator and x.status = 'ready'
         and x.reminded_at is null
         and coalesce(x.ready_at, x.created_at) < now() - make_interval(mins => op.unclaimed_after_hours * 30)
       for update skip locked
    loop
      amt := coalesce(op.currency, '₹') || trim(to_char(o.total, 'FM999999990.00'));
      update public.orders set reminded_at = now() where id = o.id;
      perform public.notify_student(o.user_id, o.id,
        'Still waiting at ' || coalesce(op.short_name, op.name, 'the desk') || ': token ' || coalesce(o.token, '')
        || '. Collect it within ' || op.unclaimed_after_hours || ' hours of it being ready'
        || case when o.pay_at_pickup and o.payment_taken_at is null and o.gateway_paid_at is null
                then ' — after that it''s cleared from the shelf and ' || amt || ' becomes due on your account.'
                else ' — after that it''s cleared from the shelf.' end);
    end loop;

    for o in
      select * from public.orders x
       where x.operator_id = p_operator and x.status = 'ready'
         and coalesce(x.ready_at, x.created_at) < now() - make_interval(hours => op.unclaimed_after_hours)
       for update skip locked
    loop
      update public.orders
         set status = 'unclaimed',
             note = 'Not collected within ' || op.unclaimed_after_hours || ' hours'
       where id = o.id;
      n := n + 1;
    end loop;
  end if;

  return n;
end;
$$;

-- ============================================================
-- 7. The unclaimed message says what it costs
-- ============================================================
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
    when 'queued'    then case
                            when new.note like 'Paid online through Printif%'
                            then 'Paid ' || amt || ' online — order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '.'
                            when new.note like 'Cash at the counter%'
                            then 'Order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '. Pay ' || amt || ' in cash when you collect.'
                            else 'Order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printifi') || '.'
                          end
    when 'ready'     then 'Ready to collect. Show token ' || coalesce(ord.token, '') || ' at ' ||
                          coalesce(op.short_name, op.name, 'Printifi') ||
                          case when ord.pay_at_pickup and ord.payment_taken_at is null then ' and pay ' || amt || ' in cash.' else '.' end
    when 'collected' then 'Collected. Thanks!'
    when 'unclaimed' then 'Order ' || coalesce(ord.token, '') || ' wasn''t collected and has been cleared from the shelf at ' ||
                          coalesce(op.short_name, op.name, 'Printifi') ||
                          -- The row read here is the one before this write (the
                          -- event is logged before the row lands), so the facts
                          -- that decide it are the older ones, plus the sweep's flag.
                          case when ord.pay_at_pickup and ord.payment_taken_at is null and ord.gateway_paid_at is null
                                    and current_setting('printify.gateway', true) = '1'
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

  return new;
end;
$$;

-- ============================================================
-- 8. Settling dues
-- ============================================================
/** A student's dues, for the desk about to take them in cash: the name and the amount. */
drop function if exists public.dues_of(text);
create or replace function public.dues_of(p_user text)
returns table (user_id text, name text, dues numeric)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.dues
    from public.profiles p
   where p.id = p_user
     and (public.is_admin() or exists (select 1 from public.staff s where s.user_id = public.clerk_id()))
$$;

/**
 * Cash taken at a desk for someone's dues. The student's dues fall; the
 * desk owes Printifi what it took — a negative credit in the desk's own
 * ledger (its payout, or its fee). Any desk's staff; returns what's left.
 */
create or replace function public.settle_dues_cash(p_operator uuid, p_user text, p_amount numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  op   public.operators;
  prof public.profiles;
  amt  numeric := round(coalesce(p_amount, 0), 2);
begin
  if not public.is_staff(p_operator) then raise exception 'Not your desk'; end if;
  select * into op from public.operators where id = p_operator;
  select * into prof from public.profiles where id = p_user for update;
  if prof.id is null then raise exception 'No such student'; end if;
  if amt <= 0 then raise exception 'An amount is more than nothing'; end if;
  if amt > prof.dues then raise exception 'That''s more than the ₹% due', trim(to_char(prof.dues, 'FM999999990.00')); end if;
  perform set_config('printify.gateway', '1', true);
  update public.profiles set dues = dues - amt where id = p_user;
  insert into public.desk_credits (operator_id, user_id, amount, kind, applied_to, note, recorded_by)
  values (p_operator, p_user, -amt, 'dues_cash',
          case when op.gateway_status = 'collect' then 'payout' else 'fee' end,
          'Dues taken in cash for Printifi', public.clerk_id());
  perform public.notify_student(p_user, null,
    'Dues of ' || coalesce(op.currency, '₹') || trim(to_char(amt, 'FM999999990.00')) || ' paid at '
    || coalesce(op.short_name, op.name, 'the desk') || '. '
    || case when prof.dues - amt <= 0 then 'You can order again.' else trim(to_char(prof.dues - amt, 'FM999999990.00')) || ' still due.' end);
  return prof.dues - amt;
end;
$$;

/** Paying dues through Printifi: one row per attempt, the Cashfree order id derived from it. Server only. */
drop function if exists public.dues_begin(text);
create or replace function public.dues_begin(p_user text)
returns table (id uuid, gateway_order_id text, amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  owed numeric;
  new_id uuid := gen_random_uuid();
begin
  perform public.assert_server();
  select p.dues into owed from public.profiles p where p.id = p_user;
  if coalesce(owed, 0) <= 0 then raise exception 'Nothing is due'; end if;
  insert into public.dues_payments (id, user_id, amount, gateway_order_id)
  values (new_id, p_user, owed, 'PD' || replace(new_id::text, '-', ''));
  return query select d.id, d.gateway_order_id, d.amount from public.dues_payments d where d.id = new_id;
end;
$$;

/** Cashfree said the dues were paid. Idempotent; refuses a short amount. Server only. */
create or replace function public.dues_paid(p_id uuid, p_payment_id text, p_amount numeric, p_paid_at timestamptz default now())
returns boolean language plpgsql security definer set search_path = public as $$
declare
  d public.dues_payments;
begin
  perform public.assert_server();
  select * into d from public.dues_payments where id = p_id for update;
  if d.id is null then raise exception 'No such dues payment'; end if;
  if d.paid_at is not null then return false; end if;
  if coalesce(p_amount, 0) + 0.005 < d.amount then
    raise exception 'Paid % of %', p_amount, d.amount;
  end if;
  perform set_config('printify.gateway', '1', true);
  update public.dues_payments set paid_at = coalesce(p_paid_at, now()), gateway_payment_id = p_payment_id where id = p_id;
  update public.profiles set dues = greatest(dues - d.amount, 0) where id = d.user_id;
  perform public.notify_student(d.user_id, null,
    'Dues of ₹' || trim(to_char(d.amount, 'FM999999990.00')) || ' paid. You can order again.');
  return true;
end;
$$;

-- ============================================================
-- 9. The ledgers: no fee on an unpaid order; credits land where they belong
-- ============================================================
drop function if exists public.fee_window(uuid, timestamptz, timestamptz);
create or replace function public.fee_window(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (orders integer, fee numeric, retained numeric)
language sql stable security definer set search_path = public as $$
  select * from (
    select count(*)::integer as orders,
           coalesce(sum(o.platform_fee) filter (where o.fee_settled_at is null), 0)::numeric as fee,
           coalesce(sum(o.platform_fee) filter (where o.fee_settled_at is not null), 0)::numeric as retained
      from public.orders o
     where o.operator_id = p_operator
       and o.status in ('collected', 'unclaimed')
       and public.order_paid(o)
       and coalesce(o.collected_at, o.ready_at) >= p_from and coalesce(o.collected_at, o.ready_at) < p_to
       and (o.refund_amount is null or o.refund_amount < o.total)
  ) w
  where public.is_owner(p_operator) or public.is_admin() or public.is_server();
$$;

-- The shape is 0022's (a replay re-makes it); what's covered is netted
-- into `outstanding`, and shown as its own line by desk_credit_summary().
drop function if exists public.fee_balance(uuid);
create or replace function public.fee_balance(p_operator uuid)
returns table (accrued numeric, settled numeric, outstanding numeric)
language sql stable security definer set search_path = public as $$
  with a as (
    select coalesce(sum(o.platform_fee), 0)::numeric as v
      from public.orders o
     where o.operator_id = p_operator
       and o.status in ('collected', 'unclaimed')
       and public.order_paid(o)
       and o.fee_settled_at is null
       and (o.refund_amount is null or o.refund_amount < o.total)
  ), s as (
    select coalesce(sum(p.amount), 0)::numeric as v
      from public.platform_settlements p where p.operator_id = p_operator
  ), c as (
    -- Positive: Printifi covered an uncollected order, credited against the
    -- fee. Negative: cash the desk took for someone's dues, owed on top.
    select coalesce(sum(d.amount), 0)::numeric as v
      from public.desk_credits d where d.operator_id = p_operator and d.applied_to = 'fee'
  )
  select a.v, s.v, a.v - s.v - c.v from a, s, c
   where public.is_owner(p_operator) or public.is_admin() or public.is_server();
$$;

drop function if exists public.fee_status(uuid);
create or replace function public.fee_status(p_operator uuid)
returns table (outstanding numeric, due numeric, due_month date, grace_days integer, locks_on date, overdue boolean)
language sql stable security definer set search_path = public as $$
  with ps as (
    select s.grace_days from public.platform_settings s where s.id
  ), accrued as (
    select coalesce(sum(o.platform_fee), 0)::numeric as all_time,
           coalesce(sum(o.platform_fee) filter (
             where coalesce(o.collected_at, o.ready_at) < date_trunc('month', now())), 0)::numeric as older
      from public.orders o
     where o.operator_id = p_operator
       and o.status in ('collected', 'unclaimed')
       and public.order_paid(o)
       and o.fee_settled_at is null
       and (o.refund_amount is null or o.refund_amount < o.total)
  ), settled as (
    select coalesce(sum(p.amount), 0)::numeric as v
      from public.platform_settlements p where p.operator_id = p_operator
  ), credited as (
    select coalesce(sum(d.amount), 0)::numeric as v
      from public.desk_credits d where d.operator_id = p_operator and d.applied_to = 'fee'
  )
  select a.all_time - s.v - c.v,
         greatest(a.older - s.v - c.v, 0),
         (date_trunc('month', now()) - interval '1 month')::date,
         ps.grace_days,
         (date_trunc('month', now()) + make_interval(days => ps.grace_days))::date,
         greatest(a.older - s.v - c.v, 0) > 0
           and now() >= date_trunc('month', now()) + make_interval(days => ps.grace_days)
    from accrued a, settled s, credited c, ps
   where public.is_staff(p_operator) or public.is_admin();
$$;

drop function if exists public.admin_fee_orders(uuid, timestamptz, timestamptz);
create or replace function public.admin_fee_orders(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (id uuid, token text, collected_at timestamptz, total numeric, platform_fee numeric, payment_method text, refund_amount numeric, fee_settled_at timestamptz)
language sql stable security definer set search_path = public as $$
  select o.id, o.token, coalesce(o.collected_at, o.ready_at),
         o.total, o.platform_fee, o.payment_method,
         o.refund_amount, o.fee_settled_at
    from public.orders o
   where public.is_admin()
     and o.operator_id = p_operator
     and o.status in ('collected', 'unclaimed')
     and public.order_paid(o)
     and coalesce(o.collected_at, o.ready_at) >= p_from and coalesce(o.collected_at, o.ready_at) < p_to
     and (o.refund_amount is null or o.refund_amount < o.total)
   order by coalesce(o.collected_at, o.ready_at) desc
   limit 500;
$$;

drop function if exists public.payout_balance(uuid);
create or replace function public.payout_balance(p_operator uuid)
returns table (owed numeric, paid_out numeric, balance numeric, orders integer)
language sql stable security definer set search_path = public as $$
  with a as (
    select coalesce(sum(public.desk_share(o)), 0)::numeric as v, count(*) filter (where public.desk_share(o) > 0)::integer as n
      from public.orders o
     where o.operator_id = p_operator
  ), c as (
    select coalesce(sum(d.amount), 0)::numeric as v
      from public.desk_credits d where d.operator_id = p_operator and d.applied_to = 'payout'
  ), p as (
    select coalesce(sum(x.amount), 0)::numeric as v from public.platform_payouts x where x.operator_id = p_operator
  )
  select a.v + c.v, p.v, a.v + c.v - p.v, a.n from a, c, p
   where public.is_owner(p_operator) or public.is_admin() or public.is_server();
$$;

drop function if exists public.payout_window(uuid, timestamptz, timestamptz);
create or replace function public.payout_window(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (orders integer, gross numeric, fee numeric, share numeric)
language sql stable security definer set search_path = public as $$
  select * from (
    select (select count(*)::integer from public.orders o
             where o.operator_id = p_operator
               and o.gateway_paid_at >= p_from and o.gateway_paid_at < p_to
               and not o.gateway_split and o.status not in ('cancelled', 'failed')) as orders,
           (select coalesce(sum(o.total), 0)::numeric from public.orders o
             where o.operator_id = p_operator
               and o.gateway_paid_at >= p_from and o.gateway_paid_at < p_to
               and not o.gateway_split and o.status not in ('cancelled', 'failed')) as gross,
           (select coalesce(sum(o.platform_fee), 0)::numeric from public.orders o
             where o.operator_id = p_operator
               and o.gateway_paid_at >= p_from and o.gateway_paid_at < p_to
               and not o.gateway_split and o.status not in ('cancelled', 'failed')) as fee,
           (select coalesce(sum(public.desk_share(o)), 0)::numeric from public.orders o
             where o.operator_id = p_operator
               and o.gateway_paid_at >= p_from and o.gateway_paid_at < p_to
               and not o.gateway_split and o.status not in ('cancelled', 'failed'))
           + (select coalesce(sum(d.amount), 0)::numeric from public.desk_credits d
               where d.operator_id = p_operator and d.applied_to = 'payout'
                 and d.created_at >= p_from and d.created_at < p_to) as share
  ) w
  where public.is_owner(p_operator) or public.is_admin() or public.is_server();
$$;

-- The statement: the online orders, then the credits, in one list. A credit
-- line carries its kind where a Cashfree reference would be.
drop function if exists public.payout_orders(uuid, timestamptz, timestamptz);
create or replace function public.payout_orders(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (
  id uuid, token text, paid_at timestamptz, status text,
  total numeric, platform_fee numeric, refund_amount numeric, share numeric, payment_id text
)
language sql stable security definer set search_path = public as $$
  select * from (
    select o.id, o.token, o.gateway_paid_at as paid_at, o.status::text as status,
           o.total, o.platform_fee, o.refund_amount, public.desk_share(o) as share, o.gateway_payment_id as payment_id
      from public.orders o
     where o.operator_id = p_operator
       and o.gateway_paid_at >= p_from and o.gateway_paid_at < p_to
       and not o.gateway_split
    union all
    select d.order_id, o.token, d.created_at, case d.kind when 'unclaimed' then 'covered' else 'dues taken' end,
           coalesce(o.total, 0), coalesce(o.platform_fee, 0), null::numeric, d.amount,
           case d.kind when 'unclaimed' then 'Covered by Printifi' else 'Cash for dues' end
      from public.desk_credits d
      left join public.orders o on o.id = d.order_id
     where d.operator_id = p_operator and d.applied_to = 'payout'
       and d.created_at >= p_from and d.created_at < p_to
  ) lines
  where public.is_owner(p_operator) or public.is_admin() or public.is_server()
  order by paid_at desc
  limit 500;
$$;

/** What the desk's own Takings shows: covered orders, cash taken for dues, and which ledger each landed in. */
drop function if exists public.desk_credit_summary(uuid);
create or replace function public.desk_credit_summary(p_operator uuid)
returns table (covered_orders integer, covered numeric, dues_taken numeric, via_payout numeric, via_fee numeric)
language sql stable security definer set search_path = public as $$
  select * from (
    select count(*) filter (where d.kind = 'unclaimed')::integer,
           coalesce(sum(d.amount) filter (where d.kind = 'unclaimed'), 0)::numeric,
           coalesce(-sum(d.amount) filter (where d.kind = 'dues_cash'), 0)::numeric,
           coalesce(sum(d.amount) filter (where d.applied_to = 'payout'), 0)::numeric,
           coalesce(sum(d.amount) filter (where d.applied_to = 'fee'), 0)::numeric
      from public.desk_credits d
     where d.operator_id = p_operator
  ) s
  where public.is_staff(p_operator) or public.is_admin() or public.is_server();
$$;

-- ============================================================
-- 10. The admin's numbers and knobs
-- ============================================================
drop function if exists public.admin_cash_report();
create or replace function public.admin_cash_report()
returns table (
  dues_outstanding numeric, students_with_dues integer, students_blocked integer,
  covered_orders integer, covered numeric, recovered_online numeric, recovered_cash numeric
)
language sql stable security definer set search_path = public as $$
  select * from (
    select (select coalesce(sum(p.dues), 0)::numeric from public.profiles p),
           (select count(*)::integer from public.profiles p where p.dues > 0),
           (select count(*)::integer from public.profiles p where p.cash_blocked_until >= now()),
           (select count(*)::integer from public.desk_credits d where d.kind = 'unclaimed'),
           (select coalesce(sum(d.amount), 0)::numeric from public.desk_credits d where d.kind = 'unclaimed'),
           (select coalesce(sum(x.amount), 0)::numeric from public.dues_payments x where x.paid_at is not null),
           (select coalesce(-sum(d.amount), 0)::numeric from public.desk_credits d where d.kind = 'dues_cash')
  ) r
  where public.is_admin();
$$;

create or replace function public.set_cash_policy(
  p_start numeric, p_step numeric, p_cap numeric, p_strikes integer, p_lockout_days integer
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the admin sets the cash policy'; end if;
  if p_start is null or p_start < 0 or p_start > 5000 then raise exception 'The starting limit is 0 to 5000'; end if;
  if p_step is null or p_step < 0 or p_step > 1000 then raise exception 'The step is 0 to 1000'; end if;
  if p_cap is null or p_cap < p_start or p_cap > 20000 then raise exception 'The cap is at least the start, at most 20000'; end if;
  if p_strikes is null or p_strikes not between 1 and 10 then raise exception 'Strikes are 1 to 10'; end if;
  if p_lockout_days is null or p_lockout_days not between 1 and 365 then raise exception 'The lockout is 1 to 365 days'; end if;
  update public.platform_settings
     set cash_limit_start = p_start, cash_limit_step = p_step, cash_limit_cap = p_cap,
         cash_strikes_allowed = p_strikes, cash_lockout_days = p_lockout_days,
         updated_by = public.clerk_id(), updated_at = now()
   where id;
end;
$$;

-- ============================================================
-- 11. Grants (0036: nothing is callable until it's granted here)
-- ============================================================
grant execute on function public.cash_standing(text)                              to authenticated;
grant execute on function public.choose_cash(uuid)                                to authenticated;
grant execute on function public.signal_leaving(uuid)                             to authenticated;
grant execute on function public.dues_of(text)                                    to authenticated;
grant execute on function public.settle_dues_cash(uuid, text, numeric)            to authenticated;
grant execute on function public.desk_credit_summary(uuid)                        to authenticated;
grant execute on function public.admin_cash_report()                              to authenticated;
grant execute on function public.set_cash_policy(numeric, numeric, numeric, integer, integer) to authenticated;
grant execute on function public.fee_window(uuid, timestamptz, timestamptz)       to authenticated;
grant execute on function public.fee_balance(uuid)                                to authenticated;
grant execute on function public.fee_status(uuid)                                 to authenticated;
grant execute on function public.admin_fee_orders(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.payout_balance(uuid)                             to authenticated;
grant execute on function public.payout_window(uuid, timestamptz, timestamptz)    to authenticated;
grant execute on function public.payout_orders(uuid, timestamptz, timestamptz)    to authenticated;
-- dues_begin / dues_paid: the server's, by default privilege (service_role).
-- order_paid / cash_limit_of: read inside definer bodies.

commit;
