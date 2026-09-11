-- Print Counter — make filtered realtime subscriptions actually match.
--
-- The app now subscribes with server-side filters (`user_id=eq...` for a
-- student, `operator_id=eq...` for an operator) so a push only travels to the
-- people it concerns. That only works if the replicated row carries those
-- columns: with the default replica identity Postgres ships just the primary
-- key for the old tuple, so a filtered UPDATE or DELETE can fail to match and
-- the subscriber silently receives nothing — worse than no filter at all.
--
-- FULL costs a little more WAL per write. At a print counter's volume that is
-- nothing next to a student staring at a status that never moves.
--
-- Run after 0009.

alter table public.orders       replica identity full;
alter table public.order_events replica identity full;
alter table public.operators    replica identity full;

-- Realtime only sends what the subscriber is allowed to read, so these tables
-- must already have RLS on. Verify rather than assume.
do $$
declare
  t text;
begin
  foreach t in array array['orders', 'order_events', 'operators'] loop
    if not exists (
      select 1 from pg_tables
      where schemaname = 'public' and tablename = t and rowsecurity
    ) then
      raise exception 'RLS is off on public.% — realtime would leak rows', t;
    end if;
  end loop;
end $$;
