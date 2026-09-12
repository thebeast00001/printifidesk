-- Print Counter — the fee has a due date, and a push remembers its key.
--
-- Run after 0024.
--
-- Two of the ways the system could quietly fail, closed in the database:
--
--   * A desk that stops settling kept operating. Now the fee on orders
--     collected before the current month is due, with a grace period the
--     admin sets (fifteen days by default); once it's overdue, the desk can't
--     flip to Open until it settles. A trigger on operators enforces it —
--     the switch in the app just relays the database's own sentence. A desk
--     that is already open stays open; the lock catches the next morning.
--
--   * A push subscription is made with one VAPID public key, and a push
--     signed with a different private key is refused by the push service.
--     With the two sites deployed separately, two projects with different
--     keys would fail every desk push, silently. Each subscription now
--     records the key it was made with, and the dispatcher names the
--     mismatch instead of retrying it.

-- ============================================================
-- 1. Grace period
-- ============================================================
alter table public.platform_settings
  add column if not exists grace_days integer not null default 15
  check (grace_days >= 0 and grace_days <= 90);

-- The four-argument form from 0022 goes; the five-argument one replaces it.
drop function if exists public.set_platform_fee(numeric, numeric, text, text);
create or replace function public.set_platform_fee(
  p_percent numeric, p_min numeric, p_vpa text, p_name text, p_grace_days integer default 15
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only the admin can change the platform fee';
  end if;
  if p_percent is null or p_percent < 0 or p_percent > 25 then
    raise exception 'The fee is a percentage between 0 and 25';
  end if;
  if p_min is null or p_min < 0 then
    raise exception 'The minimum fee cannot be negative';
  end if;
  if p_grace_days is null or p_grace_days < 0 or p_grace_days > 90 then
    raise exception 'Grace is between 0 and 90 days';
  end if;
  update public.platform_settings
     set fee_percent = round(p_percent, 2),
         fee_min     = round(p_min, 2),
         payee_vpa   = nullif(trim(coalesce(p_vpa, '')), ''),
         payee_name  = nullif(trim(coalesce(p_name, '')), ''),
         grace_days  = p_grace_days,
         updated_by  = public.clerk_id(),
         updated_at  = now()
   where id;
end;
$$;

grant execute on function public.set_platform_fee(numeric, numeric, text, text, integer) to authenticated;
revoke execute on function public.set_platform_fee(numeric, numeric, text, text, integer) from anon;

-- ============================================================
-- 2. What's due, and whether it's overdue
-- ============================================================
/**
 * Fees on orders collected before the start of the current month are due;
 * what's been settled counts against the oldest first, so `due` is that
 * older accrual minus everything settled, floored at zero. Overdue once the
 * grace period past month-end has run out. Staff of the desk, or the admin.
 */
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

grant execute on function public.fee_status(uuid) to authenticated;
revoke execute on function public.fee_status(uuid) from anon;

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
      raise exception 'Printify fee for % is overdue (₹%). Settle it from Takings to open again.',
        to_char(st.due_month, 'Month YYYY'), trim(to_char(st.due, 'FM999999990.00'))
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists operators_fee_lock on public.operators;
create trigger operators_fee_lock
  before update of is_open on public.operators
  for each row execute function public.guard_fee_lock();

-- ============================================================
-- 3. A subscription remembers its key
-- ============================================================
alter table public.push_subscriptions add column if not exists vapid_key text;
