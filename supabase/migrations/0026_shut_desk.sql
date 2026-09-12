-- Print Counter — the admin can shut a desk, whatever state it's in.
--
-- Run after 0025.
--
-- Until now the only thing the admin could do about a desk that had gone
-- wrong — wrong prices, wrong person, a fee never settled, a complaint that
-- stuck — was to ask nicely. This gives the admin one verb:
--
--   shut_operator(desk, reason)   unlist it, close it, revoke its open join
--                                 codes, and pin it there: staff can't relist
--                                 it, can't open it, can't add anyone. Orders
--                                 already placed stay live so the desk can
--                                 still hand them over or refund them — a
--                                 student who has paid is not the one being
--                                 punished. The fee ledger is untouched.
--   restore_operator(desk)        the reverse; the desk is listed again and
--                                 closed, for its own staff to open.
--
-- The reason is required and kept, so a shut desk always says why. Both
-- verbs are admin-only in the function; the pins are triggers, so they hold
-- against a direct update through PostgREST, not only through the app.

-- ============================================================
-- 1. The mark
-- ============================================================
alter table public.operators add column if not exists shut_at     timestamptz;
alter table public.operators add column if not exists shut_reason text;
alter table public.operators add column if not exists shut_by     text;

-- ============================================================
-- 2. The two verbs
-- ============================================================
/** Returns how many orders are still live, so the admin knows what the desk is left holding. */
create or replace function public.shut_operator(p_operator uuid, p_reason text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  reason text := nullif(trim(coalesce(p_reason, '')), '');
  live   bigint;
begin
  if not public.is_admin() then
    raise exception 'Only the admin can shut a desk';
  end if;
  if reason is null then
    raise exception 'Say why the desk is being shut — it is kept with the desk';
  end if;
  if length(reason) > 500 then
    raise exception 'Keep the reason under five hundred characters';
  end if;
  if not exists (select 1 from public.operators where id = p_operator) then
    raise exception 'No such desk';
  end if;

  update public.operators
     set shut_at     = coalesce(shut_at, now()),
         shut_reason = reason,
         shut_by     = public.clerk_id(),
         is_listed   = false,
         is_open     = false,
         status_note = 'Closed by Printify'
   where id = p_operator;

  update public.staff_invites i
     set revoked_at = now()
   where i.operator_id = p_operator
     and i.claimed_at is null and i.revoked_at is null;

  select count(*) into live
    from public.orders o
   where o.operator_id = p_operator
     and o.status not in ('collected', 'cancelled');
  return live;
end;
$$;

create or replace function public.restore_operator(p_operator uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only the admin can restore a desk';
  end if;
  if not exists (select 1 from public.operators where id = p_operator and shut_at is not null) then
    raise exception 'That desk is not shut';
  end if;
  update public.operators
     set shut_at     = null,
         shut_reason = null,
         shut_by     = null,
         is_listed   = true,
         status_note = null
   where id = p_operator;
end;
$$;

grant execute on function public.shut_operator(uuid, text) to authenticated;
grant execute on function public.restore_operator(uuid)    to authenticated;
revoke execute on function public.shut_operator(uuid, text) from anon;
revoke execute on function public.restore_operator(uuid)    from anon;

-- ============================================================
-- 3. The pins
-- ============================================================
/**
 * Nobody but the admin touches the mark, and a shut desk can't be listed or
 * opened by its staff. Everything else — a day's close, a price edit that
 * PostgREST lets through — is left alone; what matters is that no order can
 * reach the desk and nobody new can join it.
 */
create or replace function public.guard_operator_shut()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.shut_at     is distinct from old.shut_at
   or new.shut_reason is distinct from old.shut_reason
   or new.shut_by     is distinct from old.shut_by)
     and not public.is_admin() then
    raise exception 'Only the admin shuts or restores a desk' using errcode = 'check_violation';
  end if;
  if new.shut_at is not null and not public.is_admin() then
    if new.is_open and not old.is_open then
      raise exception 'This desk was closed by Printify: %', old.shut_reason
        using errcode = 'check_violation';
    end if;
    if new.is_listed and not old.is_listed then
      raise exception 'This desk was closed by Printify and cannot be listed'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists operators_shut_guard on public.operators;
create trigger operators_shut_guard
  before update on public.operators
  for each row execute function public.guard_operator_shut();

/** No new codes and no new staff for a shut desk — whoever is asking. */
create or replace function public.guard_shut_desk_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.operators o where o.id = new.operator_id and o.shut_at is not null) then
    raise exception 'This desk was closed by Printify' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists staff_invites_shut_guard on public.staff_invites;
create trigger staff_invites_shut_guard
  before insert on public.staff_invites
  for each row execute function public.guard_shut_desk_membership();

drop trigger if exists staff_shut_guard on public.staff;
create trigger staff_shut_guard
  before insert on public.staff
  for each row execute function public.guard_shut_desk_membership();

-- ============================================================
-- 4. What the admin sees
-- ============================================================
-- RETURNS TABLE changed: dropped and put back with the mark and the live count.
drop function if exists public.admin_desks();
create function public.admin_desks()
returns table (
  id uuid, name text, campus text, is_open boolean, created_at timestamptz,
  staff_count bigint, open_invites bigint,
  owner_code text, owner_code_expires_at timestamptz,
  shut_at timestamptz, shut_reason text, live_orders bigint
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
           order by i.created_at desc limit 1),
         o.shut_at, o.shut_reason,
         (select count(*) from public.orders r
           where r.operator_id = o.id and r.status not in ('collected', 'cancelled'))
    from public.operators o
   where public.is_admin()
   order by (o.shut_at is not null), o.created_at desc;
$$;

grant execute on function public.admin_desks() to authenticated;
revoke execute on function public.admin_desks() from anon;
