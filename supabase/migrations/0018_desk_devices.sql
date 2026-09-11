-- Print Counter — a paired desk and a PIN per shift.
--
-- Run after 0017.
--
-- Nobody at a counter types a Gmail password at nine in the morning. The
-- owner signs in once and pairs the device; after that a shift starts by
-- tapping a name and typing a PIN. The PIN never replaces Clerk — it earns a
-- one-time Clerk sign-in ticket from a server route, and from then on the
-- session, the JWT, is_staff() and every RLS policy are exactly what they
-- were. As far as Postgres is concerned, Priya signed in the usual way.
--
-- Hashes use core sha256() rather than pgcrypto, which PGlite doesn't ship.
-- A four-digit PIN can't be made unguessable by hashing; what protects it is
-- that it is useless without a paired device, and five wrong tries lock it
-- for five minutes.

-- ============================================================
-- 1. Devices
-- ============================================================
create table if not exists public.desk_devices (
  id           uuid primary key default gen_random_uuid(),
  operator_id  uuid not null references public.operators on delete cascade,
  name         text not null check (length(name) between 1 and 60),
  -- sha256 of the token the device holds. The token itself is shown once.
  token_hash   text not null unique,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists desk_devices_operator on public.desk_devices (operator_id);

alter table public.desk_devices enable row level security;

-- Staff see their desk's devices. Nothing is written except through the RPCs.
drop policy if exists "staff read devices" on public.desk_devices;
create policy "staff read devices" on public.desk_devices for select
  using (public.is_staff(operator_id));

-- ============================================================
-- 2. PINs
-- ============================================================
create table if not exists public.staff_pins (
  operator_id     uuid not null references public.operators on delete cascade,
  user_id         text not null,
  pin_hash        text not null,
  salt            text not null,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (operator_id, user_id)
);

alter table public.staff_pins enable row level security;
-- No policies at all: not even the owner may read a hash. The functions below
-- are security definer and are the only way in.

create or replace function public.pin_digest(p_salt text, p_pin text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(p_salt || ':' || p_pin, 'UTF8')), 'hex')
$$;

/**
 * Sets the caller's own PIN for a desk they run. Four to six digits, and
 * nothing that is obviously not a PIN.
 */
create or replace function public.set_my_pin(p_operator uuid, p_pin text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me   text := public.clerk_id();
  salt text := gen_random_uuid()::text;
begin
  if me is null or not public.is_staff(p_operator) then
    raise exception 'Only staff of this desk can set a PIN';
  end if;
  if p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'A PIN is four to six digits';
  end if;
  if p_pin in ('0000', '1234', '1111', '123456', '000000', '111111') then
    raise exception 'Pick a PIN that is not on the first page of every guess';
  end if;

  insert into public.staff_pins (operator_id, user_id, pin_hash, salt)
  values (p_operator, me, public.pin_digest(salt, p_pin), salt)
  on conflict (operator_id, user_id) do update
    set pin_hash = excluded.pin_hash,
        salt = excluded.salt,
        failed_attempts = 0,
        locked_until = null,
        updated_at = now();
end;
$$;

grant execute on function public.set_my_pin(uuid, text) to authenticated;
revoke execute on function public.set_my_pin(uuid, text) from anon;

-- ============================================================
-- 3. Pairing
-- ============================================================
/**
 * Pairs the device this is called from. Returns the raw token exactly once;
 * only its hash is stored, so a copy of the database is not a copy of the
 * key. Sixty-four hex characters from two v4 UUIDs.
 */
create or replace function public.pair_device(p_operator uuid, p_name text)
returns text language plpgsql security definer set search_path = public as $$
declare
  me    text := public.clerk_id();
  token text;
begin
  if me is null or not public.is_staff(p_operator) then
    raise exception 'Only staff can pair a device to this desk';
  end if;
  if length(coalesce(trim(p_name), '')) not between 1 and 60 then
    raise exception 'Give the device a name';
  end if;
  -- A desk doesn't need more than a handful. Past that, revoke one first.
  if (select count(*) from public.desk_devices
       where operator_id = p_operator and revoked_at is null) >= 10 then
    raise exception 'Ten devices are already paired to this desk';
  end if;

  token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  insert into public.desk_devices (operator_id, name, token_hash, created_by)
  values (p_operator, trim(p_name), encode(sha256(convert_to(token, 'UTF8')), 'hex'), me);

  return token;
end;
$$;

create or replace function public.revoke_device(p_device uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.desk_devices
     set revoked_at = now()
   where id = p_device
     and revoked_at is null
     and public.is_staff(operator_id);
  if not found then
    raise exception 'No such device on a desk you run';
  end if;
end;
$$;

grant execute on function public.pair_device(uuid, text) to authenticated;
grant execute on function public.revoke_device(uuid)     to authenticated;
revoke execute on function public.pair_device(uuid, text) from anon;
revoke execute on function public.revoke_device(uuid)     from anon;

-- ============================================================
-- 4. What a paired device may ask, signed out
-- ============================================================
-- Both take the device token as their credential and are callable by anon:
-- a signed-out device has no other way to identify itself, and a 256-bit
-- token that only paired devices hold is a better credential than most.

/**
 * The desk's staff, for the tap-a-name screen. Names only — no emails, no
 * ids beyond what the sign-in needs — and only for a live device.
 */
create or replace function public.desk_staff(p_token text)
returns table (operator_id uuid, operator_name text, user_id text, name text, has_pin boolean)
language plpgsql security definer set search_path = public as $$
declare
  dev public.desk_devices;
begin
  select * into dev from public.desk_devices
   where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and revoked_at is null;
  if dev.id is null then
    return;
  end if;

  update public.desk_devices set last_seen_at = now() where id = dev.id;

  return query
    select dev.operator_id,
           coalesce(o.short_name, o.name),
           s.user_id,
           coalesce(p.name, p.first_name, 'Staff'),
           exists (select 1 from public.staff_pins sp
                    where sp.operator_id = dev.operator_id and sp.user_id = s.user_id)
      from public.staff s
      join public.operators o on o.id = dev.operator_id
      left join public.profiles p on p.id = s.user_id
     where s.operator_id = dev.operator_id
     order by s.created_at;
end;
$$;

/**
 * Checks a PIN for a staff member on a paired device.
 *
 * Returns a row rather than raising, and that is not a style choice: an
 * exception rolls back everything the function did, including the failed-
 * attempt counter it just incremented — so a version that raised on a wrong
 * PIN could never lock anyone out. `ok` is true with `who` set on success;
 * otherwise `message` says why, in the words the desk sees. Five wrong tries
 * lock that person, on that desk, for five minutes. A wrong guess at Priya's
 * PIN doesn't lock Rahul out.
 */
create or replace function public.desk_verify_pin(p_token text, p_user text, p_pin text)
returns table (ok boolean, who text, message text)
language plpgsql security definer set search_path = public as $$
declare
  dev public.desk_devices;
  row public.staff_pins;
begin
  select * into dev from public.desk_devices d
   where d.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and d.revoked_at is null;
  if dev.id is null then
    return query select false, null::text, 'This device is not paired to a desk'; return;
  end if;

  if not exists (select 1 from public.staff s where s.operator_id = dev.operator_id and s.user_id = p_user) then
    return query select false, null::text, 'That person is not on this desk'; return;
  end if;

  select * into row from public.staff_pins sp
   where sp.operator_id = dev.operator_id and sp.user_id = p_user;
  if row.user_id is null then
    return query select false, null::text,
      'No PIN set yet — sign in with Google once and set one in Staff'; return;
  end if;

  if row.locked_until is not null and row.locked_until > now() then
    return query select false, null::text,
      'Too many wrong tries. Locked for ' || trim(to_char(row.locked_until - now(), 'MI "min" SS "s"')); return;
  end if;

  if row.pin_hash <> public.pin_digest(row.salt, coalesce(p_pin, '')) then
    update public.staff_pins sp
       set failed_attempts = sp.failed_attempts + 1,
           locked_until = case when sp.failed_attempts + 1 >= 5 then now() + interval '5 minutes' else null end
     where sp.operator_id = dev.operator_id and sp.user_id = p_user;
    return query select false, null::text,
      case when row.failed_attempts + 1 >= 5 then 'Wrong PIN — locked for 5 minutes'
           else 'Wrong PIN' end; return;
  end if;

  update public.staff_pins sp
     set failed_attempts = 0, locked_until = null
   where sp.operator_id = dev.operator_id and sp.user_id = p_user;
  update public.desk_devices d set last_seen_at = now() where d.id = dev.id;

  return query select true, p_user, null::text;
end;
$$;

grant execute on function public.desk_staff(text)                 to anon, authenticated;
grant execute on function public.desk_verify_pin(text, text, text) to anon, authenticated;

-- ============================================================
-- 5. The staff list says who has a PIN
-- ============================================================
-- RETURNS TABLE is part of a function's identity, so it is dropped first.
drop function if exists public.list_staff(uuid);
create function public.list_staff(p_operator uuid)
returns table (user_id text, name text, email text, joined_at timestamptz, has_pin boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff(p_operator) then return; end if;
  return query
    select s.user_id, p.name, p.email, s.created_at,
           exists (select 1 from public.staff_pins sp
                    where sp.operator_id = p_operator and sp.user_id = s.user_id)
      from public.staff s
      left join public.profiles p on p.id = s.user_id
     where s.operator_id = p_operator
     order by s.created_at;
end;
$$;
grant execute on function public.list_staff(uuid) to authenticated;
revoke execute on function public.list_staff(uuid) from anon;
