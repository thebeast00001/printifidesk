-- Print Counter — claiming the first admin from inside the app.
--
-- Somebody has to be the first admin, and until now that meant opening the SQL
-- editor. This lets the first signed-in person claim it with a button instead —
-- but only while the admins table is completely empty. The moment anyone holds
-- it, this function can never grant it again, so it can't be used to escalate.
--
-- The caveat is real: on a deployment left public with no admin, the first
-- stranger to sign in could claim it. Claim it immediately after migrating.
--
-- Run after 0007.

/** Is the seat still open? Answerable by anyone signed in, unlike reading the table. */
create or replace function public.admins_exist()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins);
$$;

create or replace function public.claim_first_admin()
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  me text;
begin
  me := public.clerk_id();
  if me is null then
    raise exception 'Sign in before claiming admin';
  end if;

  -- Lock the table so two simultaneous claims can't both succeed.
  lock table public.admins in exclusive mode;

  if exists (select 1 from public.admins) then
    return false;
  end if;

  insert into public.admins (user_id, note) values (me, 'first admin, claimed in-app');
  return true;
end;
$$;

grant execute on function public.admins_exist() to authenticated;
grant execute on function public.claim_first_admin() to authenticated;
revoke execute on function public.claim_first_admin() from anon;
