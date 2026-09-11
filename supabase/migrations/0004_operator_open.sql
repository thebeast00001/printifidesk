-- Print Counter — the operator decides when Printify is open.
--
-- Opening hours were a guess about when someone would be standing at the
-- printer. Whether a job can actually be printed depends on whether a person
-- is there, so it becomes a switch they flip. `opens_at` / `closes_at` stay as
-- advertised hours, but they no longer decide anything.
--
-- Run after 0003.

alter table public.operators add column if not exists is_open boolean not null default false;
-- Optional one-liner shown to students while closed: "Back at 4pm", "Out of toner".
alter table public.operators add column if not exists status_note text;
alter table public.operators add column if not exists status_changed_at timestamptz;

-- Only the operator's own staff may flip it.
drop policy if exists "staff update operator" on public.operators;
create policy "staff update operator" on public.operators for update
  using (public.is_staff(id))
  with check (public.is_staff(id));

create or replace function public.touch_operator_status()
returns trigger language plpgsql as $$
begin
  if new.is_open is distinct from old.is_open
     or new.status_note is distinct from old.status_note then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists operators_touch_status on public.operators;
create trigger operators_touch_status
  before update on public.operators
  for each row execute function public.touch_operator_status();

-- `open` is now the switch, not the clock.
create or replace function public.operator_wait(p_operator uuid)
returns table (open boolean, pending_orders integer, pending_pages integer, wait_minutes integer)
language plpgsql stable security definer set search_path = public as $$
declare
  c public.operators;
  n integer;
  p integer;
begin
  select * into c from public.operators where id = p_operator;
  if c.id is null then return; end if;

  select count(*), coalesce(sum(o.pages), 0) into n, p
  from public.orders o
  where o.operator_id = p_operator and o.status in ('queued', 'printing', 'finishing');

  return query select
    c.is_open,
    n,
    p,
    ceil(p::numeric / greatest(c.pages_per_minute, 1))::integer + c.handling_minutes;
end;
$$;

grant execute on function public.operator_wait(uuid) to anon, authenticated;
