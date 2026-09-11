-- Print Counter — join codes.
--
-- Run after 0018.
--
-- Adding someone to a desk used to mean asking for the email they signed in
-- with, making sure they had signed in at least once, and typing it exactly.
-- Now the desk makes a code, the colleague opens it on their own phone, signs
-- in once, and is on the desk. The same code brings in a desk's first person:
-- an admin creates the desk and hands the owner a code.
--
-- Applications go. A desk is created by an admin who already knows the shop,
-- not applied for by a stranger with a form — the form was already off the
-- student side, and a review queue nobody uses is a place for mistakes.

-- ============================================================
-- 1. Codes
-- ============================================================
create table if not exists public.staff_invites (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators on delete cascade,
  -- Eight characters from an alphabet with no 0/O or 1/I. Typed, read out,
  -- or scanned — it has to survive all three.
  code        text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  -- What the desk called the person, so the list reads "Priya · XK7P-2Q4M".
  -- A label, not an identity: the name they join with is their own.
  label       text check (label is null or length(label) <= 60),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours',
  claimed_by  text,
  claimed_at  timestamptz,
  revoked_at  timestamptz
);

create index if not exists staff_invites_operator on public.staff_invites (operator_id, created_at desc);

alter table public.staff_invites enable row level security;

-- The desk sees its own codes; an admin sees every desk's. Nothing is written
-- except through the functions below.
drop policy if exists "staff read invites" on public.staff_invites;
create policy "staff read invites" on public.staff_invites for select
  using (public.is_staff(operator_id) or public.is_admin());

-- One row per claim attempt, so twenty wrong guesses in an hour is a wait,
-- not a warm-up. Rows older than a day are swept on the next attempt.
create table if not exists public.invite_attempts (
  user_id text not null,
  at      timestamptz not null default now()
);

create index if not exists invite_attempts_user on public.invite_attempts (user_id, at desc);

alter table public.invite_attempts enable row level security;
-- No policies: nobody reads this from a client.

/** Eight characters, uniformly drawn from the 32-symbol alphabet. */
create or replace function public.new_join_code()
returns text language plpgsql volatile as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  -- The first four bytes of a v4 UUID carry no version or variant bits, so
  -- two UUIDs give eight fully random bytes; 256 divides evenly by 32.
  raw   bytea := substring(decode(replace(gen_random_uuid()::text, '-', ''), 'hex') from 1 for 4)
              || substring(decode(replace(gen_random_uuid()::text, '-', ''), 'hex') from 1 for 4);
  out_  text := '';
  i     integer;
begin
  for i in 0..7 loop
    out_ := out_ || substr(alphabet, 1 + (get_byte(raw, i) % 32), 1);
  end loop;
  return out_;
end;
$$;

/**
 * Makes a code for a desk. Staff of the desk, or an admin — that second case
 * is how a brand-new desk gets its first person. Ten open codes per desk is
 * plenty; past that, revoke one.
 */
create or replace function public.create_invite(p_operator uuid, p_label text default null)
returns table (code text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  me    text := public.clerk_id();
  label text := nullif(trim(coalesce(p_label, '')), '');
  c     text;
  tries integer := 0;
begin
  if me is null or not (public.is_staff(p_operator) or public.is_admin()) then
    raise exception 'Only staff of this desk can make a join code';
  end if;
  if not exists (select 1 from public.operators where id = p_operator) then
    raise exception 'No such desk';
  end if;
  if label is not null and length(label) > 60 then
    raise exception 'Keep the label under sixty characters';
  end if;
  if (select count(*) from public.staff_invites i
       where i.operator_id = p_operator
         and i.claimed_at is null and i.revoked_at is null and i.expires_at > now()) >= 10 then
    raise exception 'Ten codes are already open for this desk — revoke one first';
  end if;

  -- A collision among a trillion is a rounding error, but a loop costs
  -- nothing and a unique violation surfacing as a 500 would cost a shift.
  loop
    c := public.new_join_code();
    begin
      insert into public.staff_invites (operator_id, code, label, created_by)
      values (p_operator, c, label, me);
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 5 then raise; end if;
    end;
  end loop;

  return query
    select i.code, i.expires_at from public.staff_invites i where i.code = c;
end;
$$;

/**
 * Joins the desk a code belongs to. Accepts the code as typed — case, dashes
 * and spaces don't matter. One use, then it's spent; the row keeps who used
 * it and when, which is the audit line a desk wants later.
 *
 * Returns a verdict row rather than raising: a raise would roll back the
 * attempt row written a moment earlier, and then twenty wrong guesses would
 * count as none. `ok` says whether they're in; otherwise `message` says why.
 * The one raise left is for a caller with no identity, before anything is
 * written.
 */
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

create or replace function public.revoke_invite(p_invite uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.staff_invites i
     set revoked_at = now()
   where i.id = p_invite
     and i.claimed_at is null
     and i.revoked_at is null
     and (public.is_staff(i.operator_id) or public.is_admin());
  if not found then
    raise exception 'No open code by that id on a desk you run';
  end if;
end;
$$;

grant execute on function public.create_invite(uuid, text) to authenticated;
grant execute on function public.claim_invite(text)        to authenticated;
grant execute on function public.revoke_invite(uuid)       to authenticated;
revoke execute on function public.new_join_code()          from public, anon, authenticated;
revoke execute on function public.create_invite(uuid, text) from anon;
revoke execute on function public.claim_invite(text)        from anon;
revoke execute on function public.revoke_invite(uuid)       from anon;

-- ============================================================
-- 2. Desks are created by an admin
-- ============================================================
/**
 * A new desk with nobody on it yet. The admin then makes a code for it and
 * hands that to the owner; the owner's own sign-in claims it. Closed and
 * listed by default, the same as an approved application used to be.
 */
create or replace function public.create_operator(p_name text, p_campus text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  name_   text := trim(coalesce(p_name, ''));
  campus_ text := trim(coalesce(p_campus, ''));
  new_id  uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can create a desk';
  end if;
  if length(name_) not between 1 and 120 then
    raise exception 'A desk needs a name students will recognise';
  end if;
  if length(campus_) not between 1 and 120 then
    raise exception 'Which campus?';
  end if;

  insert into public.operators (name, campus, short_name, is_open, is_listed)
  values (name_, campus_, split_part(name_, ',', 1), false, true)
  returning id into new_id;

  return new_id;
end;
$$;

/** Every desk with how many people run it and how many codes are open. */
create or replace function public.admin_desks()
returns table (
  id uuid, name text, campus text, is_open boolean, created_at timestamptz,
  staff_count bigint, open_invites bigint
)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.campus, o.is_open, o.created_at,
         (select count(*) from public.staff s where s.operator_id = o.id),
         (select count(*) from public.staff_invites i
           where i.operator_id = o.id
             and i.claimed_at is null and i.revoked_at is null and i.expires_at > now())
    from public.operators o
   where public.is_admin()
   order by o.created_at desc;
$$;

grant execute on function public.create_operator(text, text) to authenticated;
grant execute on function public.admin_desks()               to authenticated;
revoke execute on function public.create_operator(text, text) from anon;
revoke execute on function public.admin_desks()               from anon;

-- ============================================================
-- 3. Applications are retired
-- ============================================================
drop function if exists public.approve_application(uuid, text);
drop function if exists public.reject_application(uuid, text);
drop table if exists public.operator_applications;
