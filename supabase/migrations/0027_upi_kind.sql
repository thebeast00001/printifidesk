-- Print Counter — a UPI id says what kind it is.
--
-- Run after 0026.
--
-- The UPI apps treat two kinds of id differently. A link or QR that a
-- website generated *with the amount filled in* is refused when the payee
-- is an ordinary personal id — PhonePe says "Transaction not allowed", GPay
-- "restricted by the bank" — and accepted when the payee is a merchant id,
-- the kind behind a shop's PhonePe Business / Paytm for Business QR. The
-- link itself is built in the browser; what the database holds is which
-- kind each payee is, so the browser knows whether to put the amount in.
--
--   operators.upi_kind          'personal' (default — works for every id,
--                               the student types the amount) or 'merchant'
--                               (the amount is pre-filled).
--   operators.upi_mc            the merchant category code read off the
--                               shop's own QR, carried into the link.
--   platform_settings.payee_kind the same choice for Printify's fee id.
--
-- Staff already own their operators row (0004's policy); nothing new to
-- grant. set_platform_fee grows a sixth argument; left out (the call from
-- before 0027), the kind stays what it was.

alter table public.operators
  add column if not exists upi_kind text not null default 'personal'
  check (upi_kind in ('personal', 'merchant'));
alter table public.operators
  add column if not exists upi_mc text
  check (upi_mc is null or upi_mc ~ '^[0-9]{4}$');

alter table public.platform_settings
  add column if not exists payee_kind text not null default 'personal'
  check (payee_kind in ('personal', 'merchant'));

drop function if exists public.set_platform_fee(numeric, numeric, text, text, integer);
create or replace function public.set_platform_fee(
  p_percent numeric, p_min numeric, p_vpa text, p_name text,
  p_grace_days integer default 15, p_payee_kind text default null
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
  if p_payee_kind is not null and p_payee_kind not in ('personal', 'merchant') then
    raise exception 'The payee id is personal or merchant';
  end if;
  update public.platform_settings
     set fee_percent = round(p_percent, 2),
         fee_min     = round(p_min, 2),
         payee_vpa   = nullif(trim(coalesce(p_vpa, '')), ''),
         payee_name  = nullif(trim(coalesce(p_name, '')), ''),
         grace_days  = p_grace_days,
         payee_kind  = coalesce(p_payee_kind, payee_kind),
         updated_by  = public.clerk_id(),
         updated_at  = now()
   where id;
end;
$$;

grant execute on function public.set_platform_fee(numeric, numeric, text, text, integer, text) to authenticated;
revoke execute on function public.set_platform_fee(numeric, numeric, text, text, integer, text) from anon;
