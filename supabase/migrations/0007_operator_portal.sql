-- Print Counter — becoming an operator, and running one properly.
--
-- Until now the only way to become staff was for someone with database access
-- to run an INSERT. That's fine for the first person and useless for everyone
-- after them, so this adds a real application → review → approval path, plus
-- the columns the portal needs to accept, decline and prioritise work.
--
-- Run after 0006.

-- ============================================================
-- Admins — who reviews applications
-- ============================================================
-- Somebody has to be first. After running this migration, add yourself:
--   insert into public.admins (user_id) values ('user_xxx');
create table if not exists public.admins (
  user_id    text primary key,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = public.clerk_id());
$$;

drop policy if exists "admins read own" on public.admins;
create policy "admins read own" on public.admins for select
  using (user_id = public.clerk_id() or public.is_admin());

-- ============================================================
-- Applications
-- ============================================================
create table if not exists public.operator_applications (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  display_name  text not null,
  campus        text not null,
  location      text,
  phone         text not null,
  machine       text,
  note          text,
  status        text not null default 'pending',
  review_note   text,
  reviewed_by   text,
  reviewed_at   timestamptz,
  operator_id   uuid references public.operators on delete set null,
  created_at    timestamptz not null default now()
);

do $$ begin
  alter table public.operator_applications add constraint operator_applications_status_valid
    check (status in ('pending', 'approved', 'rejected', 'withdrawn'));
exception when duplicate_object then null;
end $$;

-- One live application per person; re-applying after a rejection is allowed.
create unique index if not exists operator_applications_one_pending
  on public.operator_applications (user_id)
  where status = 'pending';

create index if not exists operator_applications_status
  on public.operator_applications (status, created_at desc);

alter table public.operator_applications enable row level security;

drop policy if exists "applications read" on public.operator_applications;
create policy "applications read" on public.operator_applications for select
  using (user_id = public.clerk_id() or public.is_admin());

drop policy if exists "applications insert" on public.operator_applications;
create policy "applications insert" on public.operator_applications for insert
  with check (user_id = public.clerk_id() and status = 'pending');

-- An applicant may only withdraw; approving is the reviewer's job.
drop policy if exists "applications withdraw" on public.operator_applications;
create policy "applications withdraw" on public.operator_applications for update
  using (user_id = public.clerk_id() and status = 'pending')
  with check (user_id = public.clerk_id() and status in ('pending', 'withdrawn'));

drop policy if exists "applications review" on public.operator_applications;
create policy "applications review" on public.operator_applications for update
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- Approving creates the operator and the staff row in one step, so a half
-- approved application can't exist.
-- ------------------------------------------------------------
create or replace function public.approve_application(p_application uuid, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  app public.operator_applications;
  new_operator uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can approve an application';
  end if;

  select * into app from public.operator_applications where id = p_application;
  if app.id is null then raise exception 'No such application'; end if;
  if app.status <> 'pending' then raise exception 'That application is already %', app.status; end if;

  insert into public.operators (name, campus, short_name, is_open, is_listed)
  values (app.display_name, app.campus, split_part(app.display_name, ',', 1), false, true)
  returning id into new_operator;

  insert into public.staff (user_id, operator_id)
  values (app.user_id, new_operator)
  on conflict do nothing;

  update public.operator_applications
     set status = 'approved',
         review_note = p_note,
         reviewed_by = public.clerk_id(),
         reviewed_at = now(),
         operator_id = new_operator
   where id = p_application;

  return new_operator;
end;
$$;

create or replace function public.reject_application(p_application uuid, p_note text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can reject an application';
  end if;

  update public.operator_applications
     set status = 'rejected',
         review_note = p_note,
         reviewed_by = public.clerk_id(),
         reviewed_at = now()
   where id = p_application and status = 'pending';
end;
$$;

revoke execute on function public.approve_application(uuid, text) from anon;
revoke execute on function public.reject_application(uuid, text) from anon;

-- ============================================================
-- Order handling the portal needs
-- ============================================================
-- Who ended it, so the student is told "declined by the operator" rather than
-- the same word they'd see for their own cancellation.
alter table public.orders add column if not exists cancelled_by  text;
alter table public.orders add column if not exists is_priority   boolean not null default false;
alter table public.orders add column if not exists accepted_at   timestamptz;
alter table public.orders add column if not exists started_at    timestamptz;
-- Free text the operator can leave on a job for themselves.
alter table public.orders add column if not exists operator_note text;

do $$ begin
  alter table public.orders add constraint orders_cancelled_by_valid
    check (cancelled_by is null or cancelled_by in ('student', 'operator'));
exception when duplicate_object then null;
end $$;

create index if not exists orders_operator_priority
  on public.orders (operator_id, is_priority desc, created_at);

-- Stamp the operational timestamps the portal reports turnaround from.
create or replace function public.record_order_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (order_id, status, actor, note)
    values (new.id, new.status, public.clerk_id(), 'Order placed');
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.order_events (order_id, status, actor, note)
    values (new.id, new.status, public.clerk_id(), new.note);

    new.queued_at    := coalesce(new.queued_at,    case when new.status = 'queued'    then now() end);
    new.accepted_at  := coalesce(new.accepted_at,  case when new.status = 'queued'    then now() end);
    new.started_at   := coalesce(new.started_at,   case when new.status = 'printing'  then now() end);
    new.ready_at     := coalesce(new.ready_at,     case when new.status = 'ready'     then now() end);
    new.collected_at := coalesce(new.collected_at, case when new.status = 'collected' then now() end);
  end if;

  return new;
end;
$$;

-- ============================================================
-- Portal numbers
-- ============================================================
-- Aggregated in the database so the portal doesn't have to pull every order
-- just to count them.
create or replace function public.operator_stats(p_operator uuid)
returns table (
  pending        integer,
  printing       integer,
  ready          integer,
  done_today     integer,
  declined_today integer,
  pages_today    integer,
  revenue_today  numeric,
  scheduled      integer,
  median_minutes integer
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff(p_operator) then return; end if;

  return query
  with mine as (
    select * from public.orders where operator_id = p_operator
  ), today as (
    select * from mine where created_at >= date_trunc('day', now())
  )
  select
    (select count(*)::integer from mine where status = 'placed'),
    (select count(*)::integer from mine where status in ('printing', 'finishing')),
    (select count(*)::integer from mine where status = 'ready'),
    (select count(*)::integer from today where status = 'collected'),
    (select count(*)::integer from today where status in ('cancelled', 'failed')),
    (select coalesce(sum(pages), 0)::integer from today where status = 'collected'),
    (select coalesce(sum(total), 0) from today where status = 'collected'),
    (select count(*)::integer from mine
      where pickup_mode = 'scheduled' and status in ('placed', 'queued')),
    (select coalesce(
       percentile_cont(0.5) within group (
         order by extract(epoch from (collected_at - created_at)) / 60
       ), 0)::integer
     from mine where collected_at is not null);
end;
$$;

grant execute on function public.operator_stats(uuid) to authenticated;
