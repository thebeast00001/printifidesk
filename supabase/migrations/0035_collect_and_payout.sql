-- Print Counter — Printifi collects, and pays the desk out.
--
-- Run after 0034.
--
-- Cashfree declined Easy Split for the account, so the split-at-source
-- path (0032) has nowhere to go for now. This is the other way a
-- marketplace runs a gateway, and the way most do: the student pays
-- Cashfree, the money settles to Printifi, Printifi keeps its fee and
-- owes the desk the rest — paid out on a rhythm and written down here,
-- the mirror image of the fee ledger.
--
--   operators.gateway_status   gains 'collect': the admin turned online
--                              payment on for this desk with Printifi
--                              collecting. 'active' still means a split.
--   orders.gateway_split       whether the Cashfree order carried a split
--                              (set when the order is begun). False means
--                              the desk's share is Printifi's to pay out.
--   platform_payouts           what Printifi has paid a desk, when, why.
--   payout_balance()           what a desk is owed: its share of every
--                              online, unsplit, not-cancelled order, less
--                              the refunded part in proportion, less payouts.
--
-- The desk's share of an order is the bill less Printifi's fee — rounding
-- included — exactly what a split would have sent.

alter table public.operators drop constraint if exists operators_gateway_status_check;
alter table public.operators add constraint operators_gateway_status_check
  check (gateway_status in ('off', 'collect', 'pending', 'active', 'blocked'));

alter table public.orders add column if not exists gateway_split boolean not null default false;

create table if not exists public.platform_payouts (
  id          bigserial primary key,
  operator_id uuid not null references public.operators on delete cascade,
  amount      numeric(10,2) not null check (amount > 0),
  note        text check (note is null or length(note) <= 200),
  recorded_by text not null,
  created_at  timestamptz not null default now()
);
create index if not exists platform_payouts_operator on public.platform_payouts (operator_id, created_at desc);
alter table public.platform_payouts enable row level security;

drop policy if exists "payouts read" on public.platform_payouts;
create policy "payouts read" on public.platform_payouts for select
  using (public.is_staff(operator_id) or public.is_admin());
-- Writes go through record_payout() only.

-- ============================================================
-- 1. Beginning an order says whether it was split
-- ============================================================
drop function if exists public.gateway_begin(uuid, text);
create or replace function public.gateway_begin(p_order uuid, p_gateway_order_id text, p_split boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_server();
  if p_gateway_order_id !~ '^[A-Za-z0-9_-]{3,45}$' then
    raise exception 'A gateway order id is 3–45 letters, digits, - or _';
  end if;
  perform set_config('printify.gateway', '1', true);
  update public.orders
     set gateway_order_id = p_gateway_order_id,
         gateway_split    = coalesce(p_split, false)
   where id = p_order
     and status = 'placed'
     and payment_taken_at is null;
  if not found then
    raise exception 'That order is not waiting for payment';
  end if;
end;
$$;
revoke execute on function public.gateway_begin(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.gateway_begin(uuid, text, boolean) to service_role;

-- The guard pins the flag like the other gateway facts. Same body as 0034
-- with one more line in each branch.
create or replace function public.guard_order_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('printify.gateway', true) = '1' then
    return new;
  end if;

  if public.is_staff(new.operator_id) then
    if new.status = 'queued' and old.status <> 'queued' then
      new.payment_taken_at := coalesce(new.payment_taken_at, now());
      new.payment_received := coalesce(new.payment_received, new.total);
    end if;
    if new.payment_received is not null and new.payment_received < 0 then
      raise exception 'The amount received cannot be negative';
    end if;
    new.gateway_order_id   := old.gateway_order_id;
    new.gateway_payment_id := old.gateway_payment_id;
    new.gateway_paid_at    := old.gateway_paid_at;
    new.fee_settled_at     := old.fee_settled_at;
    new.gateway_refund_id  := old.gateway_refund_id;
    new.gateway_split      := old.gateway_split;
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
  new.gateway_split      := old.gateway_split;
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
    if old.status not in ('placed', 'queued') then
      raise exception 'Too late to cancel — the desk has started on it. Ask at the counter.';
    end if;
    new.cancelled_by := 'student';
  end if;

  return new;
end;
$$;

-- ============================================================
-- 2. The payout ledger
-- ============================================================
-- A desk's share of one online, unsplit order, after any refund: the bill
-- less the fee, scaled by what wasn't refunded. Cancelled and failed
-- orders count for nothing — they're refunded, not paid out.
create or replace function public.desk_share(o public.orders)
returns numeric language sql immutable as $$
  select case
           when o.gateway_paid_at is null or o.gateway_split or o.status in ('cancelled', 'failed') then 0
           when o.total <= 0 then 0
           else round((o.total - coalesce(o.platform_fee, 0))
                      * (1 - least(coalesce(o.refund_amount, 0), o.total) / o.total), 2)
         end
$$;

create or replace function public.payout_balance(p_operator uuid)
returns table (owed numeric, paid_out numeric, balance numeric, orders integer)
language sql stable security definer set search_path = public as $$
  with a as (
    select coalesce(sum(public.desk_share(o)), 0)::numeric as v, count(*) filter (where public.desk_share(o) > 0)::integer as n
      from public.orders o
     where o.operator_id = p_operator
  ), p as (
    select coalesce(sum(x.amount), 0)::numeric as v from public.platform_payouts x where x.operator_id = p_operator
  )
  select a.v, p.v, a.v - p.v, a.n from a, p
   where public.is_staff(p_operator) or public.is_admin();
$$;

create or replace function public.payout_window(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (orders integer, gross numeric, fee numeric, share numeric)
language sql stable security definer set search_path = public as $$
  select count(*)::integer,
         coalesce(sum(o.total), 0)::numeric,
         coalesce(sum(o.platform_fee), 0)::numeric,
         coalesce(sum(public.desk_share(o)), 0)::numeric
    from public.orders o
   where o.operator_id = p_operator
     and (public.is_staff(p_operator) or public.is_admin())
     and o.gateway_paid_at >= p_from and o.gateway_paid_at < p_to
     and not o.gateway_split
     and o.status not in ('cancelled', 'failed');
$$;

create or replace function public.record_payout(p_operator uuid, p_amount numeric, p_note text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  new_id bigint;
begin
  if not public.is_admin() then
    raise exception 'Only the admin records a payout';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payout is more than nothing';
  end if;
  if not exists (select 1 from public.operators where id = p_operator) then
    raise exception 'No such desk';
  end if;
  insert into public.platform_payouts (operator_id, amount, note, recorded_by)
  values (p_operator, round(p_amount, 2), nullif(trim(coalesce(p_note, '')), ''), public.clerk_id())
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.admin_payout_desks(p_from timestamptz, p_to timestamptz default now())
returns table (
  operator_id uuid, name text, campus text,
  orders integer, gross numeric, fee numeric, share numeric,
  owed numeric, paid_out numeric, balance numeric,
  gateway_status text
)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.campus,
         w.orders, w.gross, w.fee, w.share,
         b.owed, b.paid_out, b.balance,
         o.gateway_status
    from public.operators o
    cross join lateral public.payout_window(o.id, p_from, p_to) w
    cross join lateral public.payout_balance(o.id) b
   where public.is_admin()
   order by b.balance desc, o.created_at;
$$;

grant execute on function public.payout_balance(uuid) to authenticated;
grant execute on function public.payout_window(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.record_payout(uuid, numeric, text) to authenticated;
grant execute on function public.admin_payout_desks(timestamptz, timestamptz) to authenticated;
revoke execute on function public.payout_balance(uuid) from anon;
revoke execute on function public.payout_window(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.record_payout(uuid, numeric, text) from anon;
revoke execute on function public.admin_payout_desks(timestamptz, timestamptz) from anon;

-- ============================================================
-- 3. The admin turns collection on or off for a desk
-- ============================================================
create or replace function public.set_gateway_collect(p_operator uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only the admin turns online payment on';
  end if;
  update public.operators
     set gateway_status = case
           when p_on then (case when gateway_vendor_id is not null and gateway_status = 'active' then 'active' else 'collect' end)
           else (case when gateway_vendor_id is not null then gateway_status else 'off' end)
         end,
         gateway_checked_at = now()
   where id = p_operator;
  if not found then
    raise exception 'No such desk';
  end if;
end;
$$;
grant execute on function public.set_gateway_collect(uuid, boolean) to authenticated;
revoke execute on function public.set_gateway_collect(uuid, boolean) from anon;
