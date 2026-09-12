-- Print Counter — applying to run a desk, in front of the codes.
--
-- Run after 0023.
--
-- 0019 retired the application form because a review queue nobody used
-- was a place for mistakes. It comes back here in the shape the codes make
-- sensible: a person with a desk account applies; the admin reads the
-- application and accepts it; accepting creates the desk and mints an
-- owner code that only that applicant's account can claim; the admin hands
-- the code over; the applicant enters it and is on the desk. A code meant
-- for one person is useless to anyone else, so it can travel by WhatsApp.
--
-- Nothing about what a desk can do changes. Approval is the same
-- create_operator + create_invite, in one transaction, with a name on the
-- code.

-- ============================================================
-- 1. A code can be for one person
-- ============================================================
alter table public.staff_invites add column if not exists for_user text;

create or replace function public.claim_invite(p_code text)
returns table (ok boolean, operator_id uuid, operator_name text, message text)
language plpgsql security definer set search_path = public as $$
declare
  me      text := public.clerk_id();
  wanted  text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  inv     public.staff_invites;
  recent  integer;
begin
  if me is null then
    raise exception 'Sign in first';
  end if;

  delete from public.invite_attempts where at < now() - interval '1 day';
  select count(*) into recent from public.invite_attempts a
   where a.user_id = me and a.at > now() - interval '1 hour';
  if recent >= 20 then
    return query select false, null::uuid, null::text, 'Too many tries — wait an hour'; return;
  end if;
  insert into public.invite_attempts (user_id) values (me);

  if wanted !~ '^[A-HJ-NP-Z2-9]{8}$' then
    return query select false, null::uuid, null::text, 'A join code is eight letters and digits'; return;
  end if;

  select * into inv from public.staff_invites i
   where i.code = wanted
   for update;

  if inv.id is null then
    return query select false, null::uuid, null::text,
      'That code isn''t one we know — check it with whoever gave it to you'; return;
  end if;
  if inv.revoked_at is not null then
    return query select false, null::uuid, null::text, 'That code was cancelled'; return;
  end if;
  if inv.claimed_at is not null then
    return query select false, null::uuid, null::text, 'That code has already been used'; return;
  end if;
  if inv.expires_at <= now() then
    return query select false, null::uuid, null::text, 'That code has expired — ask for a fresh one'; return;
  end if;
  -- A code made for a particular applicant only works on their account.
  if inv.for_user is not null and inv.for_user <> me then
    return query select false, null::uuid, null::text,
      'That code was made for a different account — sign in as the one that applied'; return;
  end if;

  insert into public.staff (user_id, operator_id)
  values (me, inv.operator_id)
  on conflict do nothing;

  update public.staff_invites
     set claimed_by = me, claimed_at = now()
   where id = inv.id;

  return query
    select true, o.id, o.name, null::text from public.operators o where o.id = inv.operator_id;
end;
$$;

-- ============================================================
-- 2. Applications
-- ============================================================
create table if not exists public.operator_applications (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  display_name  text not null check (length(display_name) between 1 and 120),
  campus        text not null check (length(campus) between 1 and 120),
  location      text check (location is null or length(location) <= 200),
  phone         text not null check (length(phone) between 1 and 32),
  machine       text check (machine is null or length(machine) <= 200),
  note          text check (note is null or length(note) <= 1000),
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  review_note   text check (review_note is null or length(review_note) <= 500),
  reviewed_by   text,
  reviewed_at   timestamptz,
  -- Set on approval: the desk that was made, and the code that lets the
  -- applicant onto it.
  operator_id   uuid references public.operators on delete set null,
  invite_id     uuid references public.staff_invites on delete set null,
  created_at    timestamptz not null default now()
);

-- One live application per person; applying again after a rejection is fine.
create unique index if not exists operator_applications_one_pending
  on public.operator_applications (user_id) where status = 'pending';

create index if not exists operator_applications_status
  on public.operator_applications (status, created_at desc);

alter table public.operator_applications enable row level security;

-- The applicant sees their own; the admin sees every one. Every write goes
-- through the functions below — the direct-write policies 0007 once had are
-- dropped by name in case a replay put them back.
drop policy if exists "applications insert" on public.operator_applications;
drop policy if exists "applications withdraw" on public.operator_applications;
drop policy if exists "applications review" on public.operator_applications;
drop policy if exists "applications read" on public.operator_applications;
create policy "applications read" on public.operator_applications for select
  using (user_id = public.clerk_id() or public.is_admin());

/** Sends an application. Signed in, one pending at a time. */
create or replace function public.apply_for_desk(
  p_display_name text, p_campus text, p_location text, p_phone text, p_machine text, p_note text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  me     text := public.clerk_id();
  new_id uuid;
begin
  if me is null then
    raise exception 'Sign in to apply';
  end if;
  if exists (select 1 from public.staff s where s.user_id = me) then
    raise exception 'You already run a desk';
  end if;
  if exists (select 1 from public.operator_applications a where a.user_id = me and a.status = 'pending') then
    raise exception 'You already have an application waiting to be reviewed';
  end if;

  insert into public.operator_applications (user_id, display_name, campus, location, phone, machine, note)
  values (
    me,
    trim(p_display_name),
    trim(p_campus),
    nullif(trim(coalesce(p_location, '')), ''),
    trim(p_phone),
    nullif(trim(coalesce(p_machine, '')), ''),
    nullif(trim(coalesce(p_note, '')), '')
  )
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.withdraw_application(p_application uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.operator_applications
     set status = 'withdrawn'
   where id = p_application and user_id = public.clerk_id() and status = 'pending';
  if not found then
    raise exception 'No pending application of yours by that id';
  end if;
end;
$$;

/**
 * Accepting: the desk is created and an owner code minted for the
 * applicant's account, in one transaction — a half-approved application
 * can't exist. The code comes back so the admin can hand it over.
 */
create or replace function public.approve_application(p_application uuid, p_note text default null)
returns table (operator_id uuid, code text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  app     public.operator_applications;
  new_op  uuid;
  c       text;
  tries   integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Only the admin can approve an application';
  end if;

  select * into app from public.operator_applications where id = p_application for update;
  if app.id is null then raise exception 'No such application'; end if;
  if app.status <> 'pending' then raise exception 'That application is already %', app.status; end if;

  insert into public.operators (name, campus, short_name, is_open, is_listed)
  values (app.display_name, app.campus, split_part(app.display_name, ',', 1), false, true)
  returning id into new_op;

  -- The owner code, for this applicant only.
  loop
    c := public.new_join_code();
    begin
      insert into public.staff_invites (operator_id, code, label, created_by, for_user)
      values (new_op, c, 'Owner', public.clerk_id(), app.user_id);
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 5 then raise; end if;
    end;
  end loop;

  update public.operator_applications
     set status      = 'approved',
         review_note = nullif(trim(coalesce(p_note, '')), ''),
         reviewed_by = public.clerk_id(),
         reviewed_at = now(),
         operator_id = new_op,
         invite_id   = (select i.id from public.staff_invites i where i.code = c)
   where id = p_application;

  return query
    select new_op, i.code, i.expires_at from public.staff_invites i where i.code = c;
end;
$$;

create or replace function public.reject_application(p_application uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only the admin can reject an application';
  end if;
  if length(trim(coalesce(p_note, ''))) = 0 then
    raise exception 'Say why — the applicant sees it';
  end if;
  update public.operator_applications
     set status      = 'rejected',
         review_note = trim(p_note),
         reviewed_by = public.clerk_id(),
         reviewed_at = now()
   where id = p_application and status = 'pending';
  if not found then
    raise exception 'No pending application by that id';
  end if;
end;
$$;

/**
 * The applicant's view of their own accepted application: the desk's name
 * and whether the code is still live. Never the code itself — that comes
 * from the admin, which is the point.
 */
create or replace function public.my_application()
returns table (
  id uuid, display_name text, campus text, status text, review_note text,
  created_at timestamptz, reviewed_at timestamptz,
  code_live boolean, code_expires_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select a.id, a.display_name, a.campus, a.status, a.review_note, a.created_at, a.reviewed_at,
         (i.id is not null and i.claimed_at is null and i.revoked_at is null and i.expires_at > now()),
         case when i.claimed_at is null and i.revoked_at is null then i.expires_at end
    from public.operator_applications a
    left join public.staff_invites i on i.id = a.invite_id
   where a.user_id = public.clerk_id()
   order by a.created_at desc
   limit 1;
$$;

/** Every application with, for approved ones, the code while it's live. Admin only. */
create or replace function public.admin_applications(p_status text default null)
returns table (
  id uuid, user_id text, display_name text, campus text, location text, phone text,
  machine text, note text, status text, review_note text, reviewed_at timestamptz,
  operator_id uuid, created_at timestamptz,
  applicant_name text, applicant_email text,
  code text, code_expires_at timestamptz, code_claimed boolean
)
language sql stable security definer set search_path = public as $$
  select a.id, a.user_id, a.display_name, a.campus, a.location, a.phone, a.machine, a.note,
         a.status, a.review_note, a.reviewed_at, a.operator_id, a.created_at,
         p.name, p.email,
         case when i.claimed_at is null and i.revoked_at is null and i.expires_at > now() then i.code end,
         case when i.claimed_at is null and i.revoked_at is null and i.expires_at > now() then i.expires_at end,
         (i.claimed_at is not null)
    from public.operator_applications a
    left join public.profiles p on p.id = a.user_id
    left join public.staff_invites i on i.id = a.invite_id
   where public.is_admin()
     and (p_status is null or a.status = p_status)
   order by (a.status = 'pending') desc, a.created_at desc;
$$;

grant execute on function public.apply_for_desk(text, text, text, text, text, text) to authenticated;
grant execute on function public.withdraw_application(uuid)                       to authenticated;
grant execute on function public.approve_application(uuid, text)                  to authenticated;
grant execute on function public.reject_application(uuid, text)                   to authenticated;
grant execute on function public.my_application()                                 to authenticated;
grant execute on function public.admin_applications(text)                         to authenticated;
revoke execute on function public.apply_for_desk(text, text, text, text, text, text) from anon;
revoke execute on function public.withdraw_application(uuid)                       from anon;
revoke execute on function public.approve_application(uuid, text)                  from anon;
revoke execute on function public.reject_application(uuid, text)                   from anon;
revoke execute on function public.my_application()                                 from anon;
revoke execute on function public.admin_applications(text)                         from anon;
