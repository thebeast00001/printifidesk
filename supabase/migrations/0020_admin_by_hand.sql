-- Print Counter — one admin, granted by hand; staff belong to the desk.
--
-- Run after 0019.
--
-- Two lines drawn more sharply:
--
-- 1. Nobody becomes an admin from inside the app. 0008 let the first signed-in
--    person claim the seat with a button while the table was empty — which,
--    after a reset or on a fresh deployment, is exactly the moment a stranger
--    could take it. That function is gone. The only way into `admins` is an
--    INSERT in the Supabase SQL editor, which only the project's owner can
--    open. There is no policy that lets a client write the table, and none is
--    added here.
--
-- 2. The admin creates desks; the desk runs itself. An admin can make a code
--    for a desk that has nobody on it yet — that's how the owner gets in — and
--    from the moment someone is on staff, codes are the desk's business alone.
--    The admin sees how many people a desk has, never who, and cannot add,
--    remove, or invite past that first person.

-- ============================================================
-- 1. No in-app path to admin
-- ============================================================
drop function if exists public.claim_first_admin();

-- admins_exist() stays: it only answers "is there one?", so /admin and
-- /diagnostics can say whether the seat is empty or held by someone else.

-- ============================================================
-- 2. Codes: staff of the desk, or an admin only for an empty desk
-- ============================================================
create or replace function public.can_invite_for(p_operator uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_staff(p_operator)
      or (public.is_admin()
          and not exists (select 1 from public.staff s where s.operator_id = p_operator));
$$;

revoke execute on function public.can_invite_for(uuid) from public, anon, authenticated;

create or replace function public.create_invite(p_operator uuid, p_label text default null)
returns table (code text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  me    text := public.clerk_id();
  label text := nullif(trim(coalesce(p_label, '')), '');
  c     text;
  tries integer := 0;
begin
  if me is null or not public.can_invite_for(p_operator) then
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

create or replace function public.revoke_invite(p_invite uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.staff_invites i
     set revoked_at = now()
   where i.id = p_invite
     and i.claimed_at is null
     and i.revoked_at is null
     and public.can_invite_for(i.operator_id);
  if not found then
    raise exception 'No open code by that id on a desk you run';
  end if;
end;
$$;

-- The desk reads its own codes. An admin never lists them; the one code an
-- admin makes comes back from create_invite() and is shown once.
drop policy if exists "staff read invites" on public.staff_invites;
create policy "staff read invites" on public.staff_invites for select
  using (public.is_staff(operator_id));
