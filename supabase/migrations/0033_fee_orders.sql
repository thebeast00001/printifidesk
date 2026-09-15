-- Print Counter — the fee, order by order, for the admin.
--
-- Run after 0032.
--
-- /admin shows each desk's fee as a total for the period. This is the
-- list under it: every collected, unrefunded order in the window with its
-- token, when it was collected, the bill, the fee, how it was paid, and
-- whether the fee is still the desk's to hand over or was retained at
-- source (0032). No names, no files — the admin sees the money, not the
-- student. Admin only, like admin_fee_desks().

drop function if exists public.admin_fee_orders(uuid, timestamptz, timestamptz);
create function public.admin_fee_orders(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (
  id uuid, token text, collected_at timestamptz,
  total numeric, platform_fee numeric, payment_method text,
  refund_amount numeric, fee_settled_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select o.id, o.token, o.collected_at,
         o.total, o.platform_fee, o.payment_method,
         o.refund_amount, o.fee_settled_at
    from public.orders o
   where public.is_admin()
     and o.operator_id = p_operator
     and o.status = 'collected'
     and o.collected_at >= p_from and o.collected_at < p_to
     and (o.refund_amount is null or o.refund_amount < o.total)
   order by o.collected_at desc
   limit 500;
$$;

grant execute on function public.admin_fee_orders(uuid, timestamptz, timestamptz) to authenticated;
revoke execute on function public.admin_fee_orders(uuid, timestamptz, timestamptz) from anon;
