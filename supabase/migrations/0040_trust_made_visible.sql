-- Printify — 0040: trust, made visible.
--
-- Run after 0039.
--
-- "Printify collects and pays me later" asks a desk to extend credit to a
-- stranger. Three things that make the promise checkable and revocable:
--
-- 1. The owner's switch. `operators.gateway_paused` — the desk's owner can
--    pause payments through Printify at any moment (students then pay the
--    desk directly, as ever) and resume them. Switching on in the first
--    place is still the admin's (`set_gateway_collect`); pausing is the
--    owner's, and staff can't touch it.
-- 2. The money, per order, and what each payout covered. `payout_orders()`
--    lists every online-paid order with the bill, the fee, the share and
--    Cashfree's reference. A payout now records the window it covers
--    (`covers_from`/`covers_to`), so the desk can open any payout and see
--    exactly which orders made it up.
-- 3. A fixed payout day. `platform_settings.payout_weekday` (1 = Monday …
--    7 = Sunday), set by the admin, read by the desk's Takings ("Next
--    payout: Mon 22 Sep") and the terms for desks.

-- ============================================================
-- 1. The owner's switch
-- ============================================================
alter table public.operators
  add column if not exists gateway_paused boolean not null default false;

-- The same guard as 0039, with the switch on the owner's list.
create or replace function public.guard_operator_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
begin
  if new.extras is distinct from old.extras then
    if jsonb_typeof(new.extras) <> 'array' or jsonb_array_length(new.extras) > 12 then
      raise exception 'Up to twelve extras, as a list';
    end if;
    for e in select value from jsonb_array_elements(new.extras) loop
      if jsonb_typeof(e) <> 'object'
         or coalesce(e ->> 'id', '') !~ '^[a-z0-9][a-z0-9-]{0,39}$'
         or length(coalesce(e ->> 'name', '')) not between 1 and 40
         or coalesce(e ->> 'per', '') not in ('copy', 'job')
         or (e ->> 'price') is null
         or (e ->> 'price')::numeric < 0 or (e ->> 'price')::numeric > 5000 then
        raise exception 'Each extra needs a name, a price up to 5000, and per copy or per job';
      end if;
    end loop;
    if (select count(distinct e2 ->> 'id') from jsonb_array_elements(new.extras) e2)
       <> jsonb_array_length(new.extras) then
      raise exception 'Two extras share an id';
    end if;
  end if;

  if new.hours is not null and new.hours is distinct from old.hours then
    if jsonb_typeof(new.hours) <> 'object' then
      raise exception 'Hours are a map of weekday to open/close';
    end if;
    for e in select value from jsonb_each(new.hours) loop
      if jsonb_typeof(e) = 'null' then continue; end if;
      if jsonb_typeof(e) <> 'object'
         or (e ->> 'open') !~ '^[0-2][0-9]:[0-5][0-9]$'
         or (e ->> 'close') !~ '^[0-2][0-9]:[0-5][0-9]$' then
        raise exception 'Each day is open and close as HH:MM, or closed';
      end if;
    end loop;
  end if;

  if public.is_admin() or public.is_server() or public.is_owner(old.id) then
    return new;
  end if;

  if new.name is distinct from old.name or new.campus is distinct from old.campus
     or new.short_name is distinct from old.short_name or new.currency is distinct from old.currency
     or new.bw_per_page is distinct from old.bw_per_page or new.colour_per_page is distinct from old.colour_per_page
     or new.duplex_discount is distinct from old.duplex_discount or new.staple_price is distinct from old.staple_price
     or new.bulk_threshold is distinct from old.bulk_threshold or new.bulk_multiplier is distinct from old.bulk_multiplier
     or new.min_order is distinct from old.min_order or new.paper_gsm is distinct from old.paper_gsm
     or new.pages_per_minute is distinct from old.pages_per_minute or new.handling_minutes is distinct from old.handling_minutes
     or new.is_listed is distinct from old.is_listed
     or new.opens_at is distinct from old.opens_at or new.closes_at is distinct from old.closes_at
     or new.hours is distinct from old.hours or new.closed_on is distinct from old.closed_on or new.tz is distinct from old.tz
     or new.upi_vpa is distinct from old.upi_vpa or new.upi_name is distinct from old.upi_name
     or new.upi_kind is distinct from old.upi_kind or new.upi_mc is distinct from old.upi_mc or new.upi_qr is distinct from old.upi_qr
     or new.accepts_cash is distinct from old.accepts_cash or new.round_to_rupee is distinct from old.round_to_rupee
     or new.shelf_rows is distinct from old.shelf_rows or new.shelf_cols is distinct from old.shelf_cols
     or new.extras is distinct from old.extras
     or new.low_paper_at is distinct from old.low_paper_at or new.low_toner_at is distinct from old.low_toner_at
     or new.max_pages_per_order is distinct from old.max_pages_per_order
     or new.unpaid_expiry_minutes is distinct from old.unpaid_expiry_minutes
     or new.unclaimed_after_hours is distinct from old.unclaimed_after_hours
     or new.gateway_paused is distinct from old.gateway_paused then
    raise exception 'Only the desk''s owner changes rates, payments, hours, extras and staff'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ============================================================
-- 2. The money, per order; what each payout covered
-- ============================================================
alter table public.platform_payouts
  add column if not exists covers_from timestamptz,
  add column if not exists covers_to   timestamptz;

/**
 * Every order paid through Printify for this desk in the window, with what
 * the desk is owed on each — the same desk_share() the balance sums. The
 * owner's (and the admin's, and the server's), like the balance.
 */
drop function if exists public.payout_orders(uuid, timestamptz, timestamptz);
create or replace function public.payout_orders(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (
  id uuid, token text, paid_at timestamptz, status text,
  total numeric, platform_fee numeric, refund_amount numeric, share numeric, payment_id text
)
language sql stable security definer set search_path = public as $$
  select o.id, o.token, o.gateway_paid_at, o.status::text,
         o.total, o.platform_fee, o.refund_amount, public.desk_share(o), o.gateway_payment_id
    from public.orders o
   where o.operator_id = p_operator
     and (public.is_owner(p_operator) or public.is_admin() or public.is_server())
     and o.gateway_paid_at >= p_from and o.gateway_paid_at < p_to
     and not o.gateway_split
   order by o.gateway_paid_at desc
   limit 500;
$$;

-- A payout covers the online orders paid from the previous payout's edge up
-- to a moment the admin names (the default is "now"), so a statement can be
-- drawn for it afterwards.
drop function if exists public.record_payout(uuid, numeric, text);
create or replace function public.record_payout(p_operator uuid, p_amount numeric, p_note text default null, p_covers_to timestamptz default now())
returns bigint language plpgsql security definer set search_path = public as $$
declare
  new_id bigint;
  since  timestamptz;
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
  select coalesce(max(p.covers_to), '1970-01-01'::timestamptz) into since
    from public.platform_payouts p where p.operator_id = p_operator;
  if coalesce(p_covers_to, now()) <= since then
    raise exception 'That window ends before the last payout''s did';
  end if;
  insert into public.platform_payouts (operator_id, amount, note, recorded_by, covers_from, covers_to)
  values (p_operator, round(p_amount, 2), nullif(trim(coalesce(p_note, '')), ''), public.clerk_id(), since, coalesce(p_covers_to, now()))
  returning id into new_id;
  return new_id;
end;
$$;

-- ============================================================
-- 3. A fixed payout day
-- ============================================================
alter table public.platform_settings
  add column if not exists payout_weekday integer not null default 1;
alter table public.platform_settings drop constraint if exists platform_settings_payout_weekday_valid;
alter table public.platform_settings add constraint platform_settings_payout_weekday_valid
  check (payout_weekday between 1 and 7);

create or replace function public.set_payout_day(p_weekday integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only the admin sets the payout day';
  end if;
  if p_weekday is null or p_weekday not between 1 and 7 then
    raise exception 'A weekday, 1 (Monday) to 7 (Sunday)';
  end if;
  update public.platform_settings
     set payout_weekday = p_weekday, updated_by = public.clerk_id(), updated_at = now()
   where id;
end;
$$;

-- ============================================================
-- 4. Grants
-- ============================================================
grant execute on function public.payout_orders(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.record_payout(uuid, numeric, text, timestamptz) to authenticated;
grant execute on function public.set_payout_day(integer) to authenticated;
grant execute on all functions in schema public to service_role;
