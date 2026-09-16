-- Print Counter — paying through Printifi, via Cashfree.
--
-- Run after 0031.
--
-- A desk that Printifi has connected to Cashfree Easy Split can be paid
-- online: the student pays a Cashfree order (UPI intent signed by
-- Cashfree's PSP — every app takes it, amount filled in — or a card), the
-- order is split at source (the desk's share to the desk's vendor
-- account, Printifi's fee to Printifi), and Cashfree's webhook is what
-- marks the order paid. No desk confirmation, no monthly settle-up for
-- those orders: the fee was never in the desk's hands.
--
-- What's kept:
--   operators.gateway_vendor_id  the desk's Cashfree vendor id, once
--                                Printifi has created it (admin only)
--   operators.gateway_status     off | pending | active | blocked, as
--                                Cashfree last reported it
--   orders.gateway_order_id      the Cashfree order id Printifi created
--   orders.gateway_payment_id    Cashfree's payment id, from the webhook
--   orders.gateway_paid_at       when Cashfree said so
--   orders.fee_settled_at        the fee was retained at source: excluded
--                                from what the desk owes, counted as
--                                "retained" for the admin
--   orders.gateway_refund_id     a refund Printifi asked Cashfree for
--
-- The writes come from Printifi's server with the service role — never
-- from a browser — through three security-definer functions that set a
-- transaction-local flag the guard honours. The student can't touch any
-- of these columns; the guard pins them like every other fact.

alter table public.operators add column if not exists gateway_vendor_id text;
alter table public.operators add column if not exists gateway_status text not null default 'off'
  check (gateway_status in ('off', 'pending', 'active', 'blocked'));
alter table public.operators add column if not exists gateway_checked_at timestamptz;

alter table public.orders add column if not exists gateway_order_id   text;
alter table public.orders add column if not exists gateway_payment_id text;
alter table public.orders add column if not exists gateway_paid_at    timestamptz;
alter table public.orders add column if not exists fee_settled_at     timestamptz;
alter table public.orders add column if not exists gateway_refund_id  text;
create unique index if not exists orders_gateway_order_id on public.orders (gateway_order_id)
  where gateway_order_id is not null;

alter table public.orders drop constraint if exists orders_payment_method_valid;
alter table public.orders add constraint orders_payment_method_valid
  check (payment_method is null or payment_method in ('upi', 'cash', 'gateway'));

-- ============================================================
-- 1. The server's three writes
-- ============================================================
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

-- 0035 widens this to three arguments; on a replay the wider one must go first.
drop function if exists public.gateway_begin(uuid, text, boolean);
create or replace function public.gateway_begin(p_order uuid, p_gateway_order_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_server();
  if p_gateway_order_id !~ '^[A-Za-z0-9_-]{3,45}$' then
    raise exception 'A gateway order id is 3–45 letters, digits, - or _';
  end if;
  perform set_config('printify.gateway', '1', true);
  update public.orders
     set gateway_order_id = p_gateway_order_id
   where id = p_order
     and status = 'placed'
     and payment_taken_at is null;
  if not found then
    raise exception 'That order is not waiting for payment';
  end if;
end;
$$;

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

-- The server only. A browser has no service role and gets nothing here.
revoke execute on function public.gateway_begin(uuid, text) from public, anon, authenticated;
revoke execute on function public.gateway_paid(uuid, text, numeric, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.gateway_refunded(uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.gateway_begin(uuid, text) to service_role;
grant execute on function public.gateway_paid(uuid, text, numeric, text, timestamptz) to service_role;
grant execute on function public.gateway_refunded(uuid, text, numeric, text) to service_role;

-- ============================================================
-- 2. The guard: the server's flag, and five more pins
-- ============================================================
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
    new.cancelled_by := 'student';
  end if;

  return new;
end;
$$;

-- ============================================================
-- 3. The ledger: a fee retained at source is not owed
-- ============================================================
drop function if exists public.fee_window(uuid, timestamptz, timestamptz);
create function public.fee_window(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (orders integer, fee numeric, retained numeric)
language sql stable security definer set search_path = public as $$
  select count(*)::integer,
         coalesce(sum(o.platform_fee) filter (where o.fee_settled_at is null), 0)::numeric,
         coalesce(sum(o.platform_fee) filter (where o.fee_settled_at is not null), 0)::numeric
    from public.orders o
   where o.operator_id = p_operator
     and (public.is_staff(p_operator) or public.is_admin())
     and o.status = 'collected'
     and o.collected_at >= p_from and o.collected_at < p_to
     and (o.refund_amount is null or o.refund_amount < o.total);
$$;
grant execute on function public.fee_window(uuid, timestamptz, timestamptz) to authenticated;

create or replace function public.fee_balance(p_operator uuid)
returns table (accrued numeric, settled numeric, outstanding numeric)
language sql stable security definer set search_path = public as $$
  with a as (
    select coalesce(sum(o.platform_fee), 0)::numeric as v
      from public.orders o
     where o.operator_id = p_operator
       and o.status = 'collected'
       and o.fee_settled_at is null
       and (o.refund_amount is null or o.refund_amount < o.total)
  ), s as (
    select coalesce(sum(p.amount), 0)::numeric as v
      from public.platform_settlements p where p.operator_id = p_operator
  )
  select a.v, s.v, a.v - s.v from a, s
   where public.is_staff(p_operator) or public.is_admin();
$$;

create or replace function public.fee_status(p_operator uuid)
returns table (
  outstanding numeric,
  due         numeric,
  due_month   date,
  grace_days  integer,
  locks_on    date,
  overdue     boolean
)
language sql stable security definer set search_path = public as $$
  with ps as (
    select s.grace_days from public.platform_settings s where s.id
  ), accrued as (
    select coalesce(sum(o.platform_fee), 0)::numeric as all_time,
           coalesce(sum(o.platform_fee) filter (
             where o.collected_at < date_trunc('month', now())), 0)::numeric as older
      from public.orders o
     where o.operator_id = p_operator
       and o.status = 'collected'
       and o.fee_settled_at is null
       and (o.refund_amount is null or o.refund_amount < o.total)
  ), settled as (
    select coalesce(sum(p.amount), 0)::numeric as v
      from public.platform_settlements p where p.operator_id = p_operator
  )
  select a.all_time - s.v,
         greatest(a.older - s.v, 0),
         (date_trunc('month', now()) - interval '1 month')::date,
         ps.grace_days,
         (date_trunc('month', now()) + make_interval(days => ps.grace_days))::date,
         greatest(a.older - s.v, 0) > 0
           and now() >= date_trunc('month', now()) + make_interval(days => ps.grace_days)
    from accrued a, settled s, ps
   where public.is_staff(p_operator) or public.is_admin();
$$;

drop function if exists public.admin_fee_desks(timestamptz, timestamptz);
create function public.admin_fee_desks(p_from timestamptz, p_to timestamptz default now())
returns table (
  operator_id uuid, name text, campus text,
  orders integer, fee numeric, retained numeric,
  accrued numeric, settled numeric, outstanding numeric,
  gateway_status text
)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.campus,
         w.orders, w.fee, w.retained,
         b.accrued, b.settled, b.outstanding,
         o.gateway_status
    from public.operators o
    cross join lateral public.fee_window(o.id, p_from, p_to) w
    cross join lateral public.fee_balance(o.id) b
   where public.is_admin()
   order by o.created_at;
$$;
grant execute on function public.admin_fee_desks(timestamptz, timestamptz) to authenticated;

-- Takings: what came in online, beside cash and UPI-to-the-desk.
drop function if exists public.operator_stats_range(uuid, timestamptz, timestamptz);
create function public.operator_stats_range(
  p_operator uuid,
  p_from timestamptz,
  p_to   timestamptz default now()
)
returns table (
  orders          integer,
  collected       integer,
  declined        integer,
  pages           integer,
  colour_pages    integer,
  revenue         numeric,
  refunded        numeric,
  cash_total      numeric,
  upi_total       numeric,
  online_total    numeric,
  uncollected     integer,
  median_minutes  integer,
  platform_fee    numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff(p_operator) then return; end if;

  return query
  with mine as (
    select * from public.orders o
    where o.operator_id = p_operator and o.created_at >= p_from and o.created_at < p_to
  )
  select
    (select count(*)::integer from mine),
    (select count(*)::integer from mine where mine.status = 'collected'),
    (select count(*)::integer from mine where mine.status in ('cancelled', 'failed')),
    (select coalesce(sum(mine.pages), 0)::integer from mine where mine.status = 'collected'),
    (select coalesce(sum(mine.colour_pages), 0)::integer from mine where mine.status = 'collected'),
    (select coalesce(sum(mine.total), 0) from mine where mine.status = 'collected'),
    (select coalesce(sum(mine.refund_amount), 0) from mine where mine.refunded_at is not null),
    (select coalesce(sum(mine.total), 0)
       from mine where mine.status = 'collected' and mine.payment_method = 'cash'),
    (select coalesce(sum(mine.total), 0)
       from mine where mine.status = 'collected' and mine.payment_method = 'upi'),
    (select coalesce(sum(mine.total), 0)
       from mine where mine.status = 'collected' and mine.payment_method = 'gateway'),
    (select count(*)::integer from mine where mine.status = 'ready'),
    (select coalesce(percentile_cont(0.5) within group (
       order by extract(epoch from (mine.collected_at - mine.created_at)) / 60), 0)::integer
     from mine where mine.collected_at is not null),
    (select coalesce(sum(mine.platform_fee), 0) from mine
      where mine.status = 'collected'
        and (mine.refund_amount is null or mine.refund_amount < mine.total));
end;
$$;
grant execute on function public.operator_stats_range(uuid, timestamptz, timestamptz) to authenticated;

-- ============================================================
-- 4. The admin's desk list says whether a desk is connected
-- ============================================================
drop function if exists public.admin_desks();
create function public.admin_desks()
returns table (
  id uuid, name text, campus text, is_open boolean, created_at timestamptz,
  staff_count bigint, open_invites bigint,
  owner_code text, owner_code_expires_at timestamptz,
  shut_at timestamptz, shut_reason text, live_orders bigint,
  gateway_status text, gateway_vendor_id text, gateway_checked_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.campus, o.is_open, o.created_at,
         (select count(*) from public.staff s where s.operator_id = o.id),
         (select count(*) from public.staff_invites i
           where i.operator_id = o.id
             and i.claimed_at is null and i.revoked_at is null and i.expires_at > now()),
         (select i.code from public.staff_invites i
           where i.operator_id = o.id
             and i.claimed_at is null and i.revoked_at is null and i.expires_at > now()
             and not exists (select 1 from public.staff s where s.operator_id = o.id)
           order by i.created_at desc limit 1),
         (select i.expires_at from public.staff_invites i
           where i.operator_id = o.id
             and i.claimed_at is null and i.revoked_at is null and i.expires_at > now()
             and not exists (select 1 from public.staff s where s.operator_id = o.id)
           order by i.created_at desc limit 1),
         o.shut_at, o.shut_reason,
         (select count(*) from public.orders r
           where r.operator_id = o.id and r.status not in ('collected', 'cancelled')),
         o.gateway_status, o.gateway_vendor_id, o.gateway_checked_at
    from public.operators o
   where public.is_admin()
   order by (o.shut_at is not null), o.created_at desc;
$$;

grant execute on function public.admin_desks() to authenticated;
revoke execute on function public.admin_desks() from anon;
