-- Print Counter — the live capsule paints after one round trip, not two.
--
-- Run after 0028.
--
-- The student's capsule needed the active order, then — once it knew the
-- id — that order's place in the queue. Two trips in sequence, and from a
-- phone in India to a database that isn't, each one is half a second. This
-- finds the caller's newest live order itself, so the capsule can ask for
-- the order (with its timeline embedded) and the queue position at the
-- same time. Same arithmetic as queue_status(); it only saves the wait.

create or replace function public.queue_status_mine()
returns table (order_id uuid, place integer, pages_ahead integer, wait_minutes integer)
language sql stable security definer set search_path = public as $$
  select o.id, q.place, q.pages_ahead, q.wait_minutes
    from public.orders o
    cross join lateral public.queue_status(o.id) q
   where o.user_id = public.clerk_id()
     and o.status in ('placed', 'queued', 'printing', 'finishing', 'ready')
   order by o.created_at desc
   limit 1;
$$;

grant execute on function public.queue_status_mine() to authenticated;
revoke execute on function public.queue_status_mine() from anon;
