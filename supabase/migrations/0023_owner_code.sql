-- Print Counter — the owner code is readable until it's used, and there is
-- only ever one.
--
-- Run after 0022.
--
-- An owner code is the admin's ticket to a desk's first person. It was
-- shown once, at the moment it was made; lose the message and the only
-- move was to mint another, leaving the first alive for the rest of its
-- day. Two changes:
--
--   * admin_desks() carries the live owner code (and when it expires) for
--     a desk nobody is on yet. Nothing about who may see it changes — the
--     admin made it — and once someone joins, it's null.
--   * create_invite() by an admin, for an empty desk, cancels that desk's
--     other open codes first. A desk with nobody on it has one live code.

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

  -- The admin's code for an empty desk replaces any earlier one: a lost
  -- message shouldn't leave a second key lying around.
  if public.is_admin() and not exists (select 1 from public.staff s where s.operator_id = p_operator) then
    update public.staff_invites i
       set revoked_at = now()
     where i.operator_id = p_operator
       and i.claimed_at is null and i.revoked_at is null;
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

-- RETURNS TABLE changed: dropped and put back with the code alongside.
drop function if exists public.admin_desks();
create function public.admin_desks()
returns table (
  id uuid, name text, campus text, is_open boolean, created_at timestamptz,
  staff_count bigint, open_invites bigint,
  owner_code text, owner_code_expires_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.campus, o.is_open, o.created_at,
         (select count(*) from public.staff s where s.operator_id = o.id),
         (select count(*) from public.staff_invites i
           where i.operator_id = o.id
             and i.claimed_at is null and i.revoked_at is null and i.expires_at > now()),
         -- The live code, only while nobody is on the desk yet.
         (select i.code from public.staff_invites i
           where i.operator_id = o.id
             and i.claimed_at is null and i.revoked_at is null and i.expires_at > now()
             and not exists (select 1 from public.staff s where s.operator_id = o.id)
           order by i.created_at desc limit 1),
         (select i.expires_at from public.staff_invites i
           where i.operator_id = o.id
             and i.claimed_at is null and i.revoked_at is null and i.expires_at > now()
             and not exists (select 1 from public.staff s where s.operator_id = o.id)
           order by i.created_at desc limit 1)
    from public.operators o
   where public.is_admin()
   order by o.created_at desc;
$$;

grant execute on function public.admin_desks() to authenticated;
revoke execute on function public.admin_desks() from anon;
