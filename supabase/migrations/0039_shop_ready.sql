-- Printify — 0039: what a shop asks for in its first week.
--
-- Run after 0038 — on its own, after 0038 has been run: this file names the
-- status 0038 adds, and Postgres refuses a new enum value in the same
-- transaction that added it.
--
-- 1. An owner and their staff. `staff.role` — 'owner' or 'staff'. The
--    earliest member of every existing desk becomes its owner. Staff run
--    the queue; only the owner touches the rate card, UPI, hours, extras,
--    staff, devices, refunds and takings. Codes carry a role; an admin's
--    code for an empty desk makes an owner.
-- 2. Hours by weekday, days closed, a timezone. `operator_open_at()` is the
--    one answer to "open now?" — the switch AND the schedule AND not a
--    closed day AND not shut. `opens_at`/`closes_at` stay as the fallback
--    for a desk that hasn't set weekly hours.
-- 3. Extras: named add-ons per desk (spiral binding, lamination, A3…),
--    each priced per copy or per job, chosen per file. Priced in
--    price_line() exactly as quoteOrder() does, snapshotted on the order.
-- 4. A corrected bill. The desk can correct page and colour counts on an
--    unpaid order; the student accepts the new price or cancels. Priced
--    from the order's own rate-card snapshot, never today's rates.
-- 5. Orders that go nowhere. A desk-set window after which an unpaid order
--    is cancelled by the system, and one after which a ready order nobody
--    collected is marked 'unclaimed' — shelf slot freed, files purged, the
--    desk's money kept (it printed). `sweep_orders()` does it, run by the
--    desk portal on load and by the daily cron for every desk.
-- 6. The bucket accepts only what the desk can print: PDF and images.

-- ============================================================
-- 1. Owner and staff
-- ============================================================
alter table public.staff add column if not exists role text not null default 'staff';
alter table public.staff drop constraint if exists staff_role_valid;
alter table public.staff add constraint staff_role_valid check (role in ('owner', 'staff'));

-- The first person on each desk is its owner; only where no owner exists yet.
with first_in as (
  select distinct on (operator_id) operator_id, user_id
    from public.staff
   order by operator_id, created_at, user_id
)
update public.staff s
   set role = 'owner'
  from first_in f
 where s.operator_id = f.operator_id and s.user_id = f.user_id
   and not exists (select 1 from public.staff o where o.operator_id = s.operator_id and o.role = 'owner');

create or replace function public.is_owner(p_operator uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = public.clerk_id() and s.operator_id = p_operator and s.role = 'owner'
  );
$$;

alter table public.staff_invites add column if not exists role text not null default 'staff';
alter table public.staff_invites drop constraint if exists staff_invites_role_valid;
alter table public.staff_invites add constraint staff_invites_role_valid check (role in ('owner', 'staff'));

-- Codes: the owner's to make; the admin's only for a desk with nobody on it.
create or replace function public.can_invite_for(p_operator uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_owner(p_operator)
      or (public.is_admin()
          and not exists (select 1 from public.staff s where s.operator_id = p_operator));
$$;

drop function if exists public.create_invite(uuid, text);
create or replace function public.create_invite(p_operator uuid, p_label text default null, p_role text default 'staff')
returns table (code text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  me    text := public.clerk_id();
  label text := nullif(trim(coalesce(p_label, '')), '');
  role  text := coalesce(p_role, 'staff');
  c     text;
  tries integer := 0;
begin
  if me is null or not public.can_invite_for(p_operator) then
    raise exception 'Only the desk''s owner makes join codes';
  end if;
  if not exists (select 1 from public.operators where id = p_operator) then
    raise exception 'No such desk';
  end if;
  if role not in ('owner', 'staff') then
    raise exception 'A code is for an owner or for staff';
  end if;
  if label is not null and length(label) > 60 then
    raise exception 'Keep the label under sixty characters';
  end if;
  -- An empty desk's first person is its owner, whatever was asked.
  if not exists (select 1 from public.staff s where s.operator_id = p_operator) then
    role := 'owner';
  end if;

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
      insert into public.staff_invites (operator_id, code, label, created_by, role)
      values (p_operator, c, label, me, role);
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

drop function if exists public.claim_invite(text);
create or replace function public.claim_invite(p_code text)
returns table (ok boolean, operator_id uuid, operator_name text, message text)
language plpgsql security definer set search_path = public as $$
declare
  me      text := public.clerk_id();
  wanted  text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  inv     public.staff_invites;
  recent  integer;
  as_role text;
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
  if inv.for_user is not null and inv.for_user <> me then
    return query select false, null::uuid, null::text,
      'That code was made for a different account — sign in as the one that applied'; return;
  end if;

  -- The code's role; and a desk with no owner yet gets one, whatever the code said.
  as_role := inv.role;
  if not exists (select 1 from public.staff s where s.operator_id = inv.operator_id and s.role = 'owner') then
    as_role := 'owner';
  end if;

  insert into public.staff (user_id, operator_id, role)
  values (me, inv.operator_id, as_role)
  on conflict do nothing;

  update public.staff_invites
     set claimed_by = me, claimed_at = now()
   where id = inv.id;

  return query
    select true, o.id, o.name, null::text from public.operators o where o.id = inv.operator_id;
end;
$$;

drop function if exists public.list_staff(uuid);
create or replace function public.list_staff(p_operator uuid)
returns table (user_id text, name text, email text, joined_at timestamptz, has_pin boolean, role text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff(p_operator) then return; end if;
  return query
    select s.user_id, p.name, p.email, s.created_at,
           exists (select 1 from public.staff_pins sp
                    where sp.operator_id = p_operator and sp.user_id = s.user_id),
           s.role
      from public.staff s
      left join public.profiles p on p.id = s.user_id
     where s.operator_id = p_operator
     order by case s.role when 'owner' then 0 else 1 end, s.created_at;
end;
$$;

drop function if exists public.add_staff(uuid, text);
create or replace function public.add_staff(p_operator uuid, p_email text, p_role text default 'staff')
returns text language plpgsql security definer set search_path = public as $$
declare
  target text;
begin
  if not public.is_owner(p_operator) then
    raise exception 'Only the desk''s owner adds staff';
  end if;
  if coalesce(p_role, 'staff') not in ('owner', 'staff') then
    raise exception 'A person is an owner or staff';
  end if;

  select id into target from public.profiles
   where lower(email) = lower(trim(p_email))
   limit 1;

  if target is null then
    raise exception 'No Printify account with that email. They need to sign in once first.';
  end if;

  insert into public.staff (user_id, operator_id, role)
  values (target, p_operator, coalesce(p_role, 'staff'))
  on conflict do nothing;

  return target;
end;
$$;

create or replace function public.remove_staff(p_operator uuid, p_user text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_operator) then
    raise exception 'Only the desk''s owner removes staff';
  end if;
  if (select count(*) from public.staff where operator_id = p_operator) <= 1 then
    raise exception 'That would leave nobody running this desk';
  end if;
  -- Never the last owner: a desk with no owner can't be run from the app.
  if exists (select 1 from public.staff s where s.operator_id = p_operator and s.user_id = p_user and s.role = 'owner')
     and (select count(*) from public.staff s where s.operator_id = p_operator and s.role = 'owner') <= 1 then
    raise exception 'Make someone else the owner first';
  end if;
  delete from public.staff where operator_id = p_operator and user_id = p_user;
end;
$$;

create or replace function public.set_staff_role(p_operator uuid, p_user text, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_operator) then
    raise exception 'Only the desk''s owner changes roles';
  end if;
  if p_role not in ('owner', 'staff') then
    raise exception 'A person is an owner or staff';
  end if;
  if not exists (select 1 from public.staff s where s.operator_id = p_operator and s.user_id = p_user) then
    raise exception 'That person is not on this desk';
  end if;
  if p_role = 'staff'
     and (select count(*) from public.staff s where s.operator_id = p_operator and s.role = 'owner') <= 1
     and exists (select 1 from public.staff s where s.operator_id = p_operator and s.user_id = p_user and s.role = 'owner') then
    raise exception 'Make someone else the owner first';
  end if;
  update public.staff set role = p_role where operator_id = p_operator and user_id = p_user;
end;
$$;

create or replace function public.pair_device(p_operator uuid, p_name text)
returns text language plpgsql security definer set search_path = public as $$
declare
  me    text := public.clerk_id();
  token text;
begin
  if me is null or not public.is_owner(p_operator) then
    raise exception 'Only the desk''s owner pairs a device';
  end if;
  if length(coalesce(trim(p_name), '')) not between 1 and 60 then
    raise exception 'Give the device a name';
  end if;
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
     and public.is_owner(operator_id);
  if not found then
    raise exception 'No such device on a desk you own';
  end if;
end;
$$;

-- Takings and the ledger: the owner's (and the admin's). fee_status stays
-- with staff — the fee lock reads it when anyone opens the desk.
--
-- Each table-returning function is dropped before it's made: Postgres won't
-- change a function's return row in place ("cannot change return type of
-- existing function"), and a project that ran an earlier shape of one of
-- these would stop here otherwise. Nothing depends on them by pg_depend —
-- SQL-language bodies aren't tracked — so the drops are safe, and the
-- admin's roll-ups that call them keep working once they're back.
drop function if exists public.fee_window(uuid, timestamptz, timestamptz);
create or replace function public.fee_window(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (orders integer, fee numeric, retained numeric)
language sql stable security definer set search_path = public as $$
  -- Gated after the aggregate: an aggregate always yields a row, and a row
  -- of zeros for staff would read as "nothing owed" rather than "not yours".
  select * from (
    select count(*)::integer as orders,
           coalesce(sum(o.platform_fee) filter (where o.fee_settled_at is null), 0)::numeric as fee,
           coalesce(sum(o.platform_fee) filter (where o.fee_settled_at is not null), 0)::numeric as retained
      from public.orders o
     where o.operator_id = p_operator
       and o.status in ('collected', 'unclaimed')
       and coalesce(o.collected_at, o.ready_at) >= p_from and coalesce(o.collected_at, o.ready_at) < p_to
       and (o.refund_amount is null or o.refund_amount < o.total)
  ) w
  where public.is_owner(p_operator) or public.is_admin() or public.is_server();
$$;

drop function if exists public.fee_balance(uuid);
create or replace function public.fee_balance(p_operator uuid)
returns table (accrued numeric, settled numeric, outstanding numeric)
language sql stable security definer set search_path = public as $$
  with a as (
    select coalesce(sum(o.platform_fee), 0)::numeric as v
      from public.orders o
     where o.operator_id = p_operator
       and o.status in ('collected', 'unclaimed')
       and o.fee_settled_at is null
       and (o.refund_amount is null or o.refund_amount < o.total)
  ), s as (
    select coalesce(sum(p.amount), 0)::numeric as v
      from public.platform_settlements p where p.operator_id = p_operator
  )
  select a.v, s.v, a.v - s.v from a, s
   where public.is_owner(p_operator) or public.is_admin() or public.is_server();
$$;

drop function if exists public.fee_status(uuid);
create or replace function public.fee_status(p_operator uuid)
returns table (outstanding numeric, due numeric, due_month date, grace_days integer, locks_on date, overdue boolean)
language sql stable security definer set search_path = public as $$
  with ps as (
    select s.grace_days from public.platform_settings s where s.id
  ), accrued as (
    select coalesce(sum(o.platform_fee), 0)::numeric as all_time,
           coalesce(sum(o.platform_fee) filter (
             where coalesce(o.collected_at, o.ready_at) < date_trunc('month', now())), 0)::numeric as older
      from public.orders o
     where o.operator_id = p_operator
       and o.status in ('collected', 'unclaimed')
       and o.fee_settled_at is null
       and (o.refund_amount is null or o.refund_amount < o.total)
  ), settled as (
    select coalesce(sum(p.amount), 0)::numeric as v
      from public.platform_settlements p where p.operator_id = p_operator
  )
  select a.all_time - s.v,
         greatest(a.older - s.v, 0),
         (date_trunc('month', now()) - interval '1 month')::date,
         ps.grace_days,
         (date_trunc('month', now()) + make_interval(days => ps.grace_days))::date,
         greatest(a.older - s.v, 0) > 0
           and now() >= date_trunc('month', now()) + make_interval(days => ps.grace_days)
    from accrued a, settled s, ps
   where public.is_staff(p_operator) or public.is_admin();
$$;

drop function if exists public.payout_balance(uuid);
create or replace function public.payout_balance(p_operator uuid)
returns table (owed numeric, paid_out numeric, balance numeric, orders integer)
language sql stable security definer set search_path = public as $$
  with a as (
    select coalesce(sum(public.desk_share(o)), 0)::numeric as v, count(*) filter (where public.desk_share(o) > 0)::integer as n
      from public.orders o
     where o.operator_id = p_operator
  ), p as (
    select coalesce(sum(x.amount), 0)::numeric as v from public.platform_payouts x where x.operator_id = p_operator
  )
  select a.v, p.v, a.v - p.v, a.n from a, p
   where public.is_owner(p_operator) or public.is_admin() or public.is_server();
$$;

drop function if exists public.payout_window(uuid, timestamptz, timestamptz);
create or replace function public.payout_window(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (orders integer, gross numeric, fee numeric, share numeric)
language sql stable security definer set search_path = public as $$
  select * from (
    select count(*)::integer as orders,
           coalesce(sum(o.total), 0)::numeric as gross,
           coalesce(sum(o.platform_fee), 0)::numeric as fee,
           coalesce(sum(public.desk_share(o)), 0)::numeric as share
      from public.orders o
     where o.operator_id = p_operator
       and o.gateway_paid_at >= p_from and o.gateway_paid_at < p_to
       and not o.gateway_split
       and o.status not in ('cancelled', 'failed')
  ) w
  where public.is_owner(p_operator) or public.is_admin() or public.is_server();
$$;

drop function if exists public.admin_fee_orders(uuid, timestamptz, timestamptz);
create or replace function public.admin_fee_orders(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (id uuid, token text, collected_at timestamptz, total numeric, platform_fee numeric, payment_method text, refund_amount numeric, fee_settled_at timestamptz)
language sql stable security definer set search_path = public as $$
  select o.id, o.token, coalesce(o.collected_at, o.ready_at),
         o.total, o.platform_fee, o.payment_method,
         o.refund_amount, o.fee_settled_at
    from public.orders o
   where public.is_admin()
     and o.operator_id = p_operator
     and o.status in ('collected', 'unclaimed')
     and coalesce(o.collected_at, o.ready_at) >= p_from and coalesce(o.collected_at, o.ready_at) < p_to
     and (o.refund_amount is null or o.refund_amount < o.total)
   order by coalesce(o.collected_at, o.ready_at) desc
   limit 500;
$$;

-- ============================================================
-- 2. Hours, days closed, a timezone
-- ============================================================
alter table public.operators
  add column if not exists hours     jsonb,
  add column if not exists closed_on date[] not null default '{}',
  add column if not exists tz        text   not null default 'Asia/Kolkata';

/**
 * The one answer to "is this desk open at this moment": its switch, its
 * hours for that weekday (weekly hours if set, else opens_at–closes_at),
 * not a day it marked closed, and not shut by the admin. A day with no
 * hours (json null) is a day off. Hours past midnight ("18:00"–"02:00")
 * count as open on either side of it.
 */
create or replace function public.operator_open_at(p_op public.operators, p_at timestamptz)
returns boolean language plpgsql stable as $$
declare
  local_ts timestamp := p_at at time zone coalesce(nullif(p_op.tz, ''), 'Asia/Kolkata');
  days     text[] := array['mon','tue','wed','thu','fri','sat','sun'];
  dow      integer := extract(isodow from local_ts)::integer;
  t        time := local_ts::time;
  today    jsonb;
  yday     jsonb;
  opens    time;
  closes   time;
begin
  if not p_op.is_open or p_op.shut_at is not null then return false; end if;
  if local_ts::date = any (coalesce(p_op.closed_on, '{}')) then return false; end if;

  if p_op.hours is null or jsonb_typeof(p_op.hours) <> 'object' then
    -- No weekly hours: opens_at-closes_at every day, as before 0039.
    if p_op.opens_at is null or p_op.closes_at is null then return true; end if;
    if p_op.closes_at > p_op.opens_at then
      return t >= p_op.opens_at and t < p_op.closes_at;
    end if;
    return t >= p_op.opens_at or t < p_op.closes_at;
  end if;

  -- Today's hours. A day that closes after midnight ("18:00" to "02:00") is
  -- open from its opening time onwards; the small hours belong to it too,
  -- read from yesterday's entry below.
  today := p_op.hours -> days[dow];
  if today is not null and jsonb_typeof(today) = 'object' then
    opens  := (today ->> 'open')::time;
    closes := (today ->> 'close')::time;
    if closes > opens then
      if t >= opens and t < closes then return true; end if;
    elsif t >= opens then
      return true;
    end if;
  end if;

  yday := p_op.hours -> days[((dow + 5) % 7) + 1];
  if yday is not null and jsonb_typeof(yday) = 'object' then
    opens  := (yday ->> 'open')::time;
    closes := (yday ->> 'close')::time;
    if closes < opens and t < closes then return true; end if;
  end if;

  return false;
end;
$$;

drop function if exists public.operator_wait(uuid);
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
  where o.operator_id = p_operator
    and o.status in ('queued', 'printing', 'finishing')
    and (o.pickup_mode = 'asap' or o.pickup_at <= now() + interval '30 minutes');

  return query select
    public.operator_open_at(c, now()),
    n,
    p,
    ceil(p::numeric / greatest(c.pages_per_minute, 1))::integer + c.handling_minutes;
end;
$$;

-- ============================================================
-- 3. Extras
-- ============================================================
alter table public.operators
  add column if not exists extras jsonb not null default '[]'::jsonb;

/** One line's price, extras included. Same arithmetic as lineCost() in lib/pricing.ts. */
create or replace function public.price_line(
  p_pages  integer,
  p_colour integer,
  p_config jsonb,
  p_op     public.operators,
  p_bulk   double precision
) returns double precision
language plpgsql stable set search_path = public as $$
declare
  colour   text    := coalesce(p_config ->> 'colour',  'smart');
  sides    text    := coalesce(p_config ->> 'sides',   'double');
  binding  text    := coalesce(p_config ->> 'binding', 'none');
  copies   integer := greatest(coalesce((p_config ->> 'copies')::integer, 1), 1);
  bw       integer;
  inked    integer;
  list_paper    double precision;
  after_bulk    double precision;
  duplex_saving double precision;
  paper         double precision;
  bind          double precision;
  extras        double precision := 0;
begin
  bw    := case colour when 'full' then 0       when 'bw' then p_pages else p_pages - p_colour end;
  inked := case colour when 'full' then p_pages when 'bw' then 0       else p_colour end;

  list_paper    := bw * coalesce(p_op.bw_per_page, 1.5)::double precision
                 + inked * coalesce(p_op.colour_per_page, 8)::double precision;
  after_bulk    := list_paper * p_bulk;
  duplex_saving := case when sides = 'double'
                        then after_bulk * coalesce(p_op.duplex_discount, 0.08)::double precision
                        else 0 end;
  paper         := after_bulk - duplex_saving;
  bind          := case when binding = 'staple' then coalesce(p_op.staple_price, 5)::double precision else 0 end;

  -- The desk's named add-ons the file chose: per copy, or once for the job.
  if p_config ? 'extras' and jsonb_typeof(p_config -> 'extras') = 'array' then
    select coalesce(sum(
             (e ->> 'price')::double precision
             * case when e ->> 'per' = 'copy' then copies else 1 end), 0)
      into extras
      from jsonb_array_elements(coalesce(p_op.extras, '[]'::jsonb)) e
     where e ->> 'id' in (select jsonb_array_elements_text(p_config -> 'extras'));
  end if;

  return (paper + bind) * copies + extras;
end;
$$;

-- ============================================================
-- 4. Orders that go nowhere: the desk's windows
-- ============================================================
alter table public.operators
  add column if not exists unpaid_expiry_minutes integer not null default 120,
  add column if not exists unclaimed_after_hours integer not null default 48;
-- A third hand on the cancel: the system, for an order nobody paid for.
alter table public.orders drop constraint if exists orders_cancelled_by_valid;
alter table public.orders add constraint orders_cancelled_by_valid
  check (cancelled_by is null or cancelled_by in ('student', 'operator', 'system'));
alter table public.operators drop constraint if exists operators_windows_sane;
alter table public.operators add constraint operators_windows_sane
  check (unpaid_expiry_minutes between 0 and 1440 and unclaimed_after_hours between 0 and 720);

-- ============================================================
-- 5. The owner's columns, and extras that make sense
-- ============================================================
create or replace function public.guard_operator_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
begin
  -- Extras are checked for everyone, the owner included.
  if new.extras is distinct from old.extras then
    if jsonb_typeof(new.extras) <> 'array' or jsonb_array_length(new.extras) > 12 then
      raise exception 'Up to twelve extras, as a list';
    end if;
    for e in select value from jsonb_array_elements(new.extras) loop
      if jsonb_typeof(e) <> 'object'
         or coalesce(e ->> 'id', '') !~ '^[a-z0-9][a-z0-9-]{0,39}$'
         or length(coalesce(e ->> 'name', '')) not between 1 and 40
         or coalesce(e ->> 'per', '') not in ('copy', 'job')
         or (e ->> 'price') is null
         or (e ->> 'price')::numeric < 0 or (e ->> 'price')::numeric > 5000 then
        raise exception 'Each extra needs a name, a price up to 5000, and per copy or per job';
      end if;
    end loop;
    if (select count(distinct e2 ->> 'id') from jsonb_array_elements(new.extras) e2)
       <> jsonb_array_length(new.extras) then
      raise exception 'Two extras share an id';
    end if;
  end if;

  if new.hours is not null and new.hours is distinct from old.hours then
    if jsonb_typeof(new.hours) <> 'object' then
      raise exception 'Hours are a map of weekday to open/close';
    end if;
    for e in select value from jsonb_each(new.hours) loop
      if jsonb_typeof(e) = 'null' then continue; end if;
      if jsonb_typeof(e) <> 'object'
         or (e ->> 'open') !~ '^[0-2][0-9]:[0-5][0-9]$'
         or (e ->> 'close') !~ '^[0-2][0-9]:[0-5][0-9]$' then
        raise exception 'Each day is open and close as HH:MM, or closed';
      end if;
    end loop;
  end if;

  if public.is_admin() or public.is_server() or public.is_owner(old.id) then
    return new;
  end if;

  -- Staff run the desk: open/closed, the note, the stock. The rest is the owner's.
  if new.name is distinct from old.name or new.campus is distinct from old.campus
     or new.short_name is distinct from old.short_name or new.currency is distinct from old.currency
     or new.bw_per_page is distinct from old.bw_per_page or new.colour_per_page is distinct from old.colour_per_page
     or new.duplex_discount is distinct from old.duplex_discount or new.staple_price is distinct from old.staple_price
     or new.bulk_threshold is distinct from old.bulk_threshold or new.bulk_multiplier is distinct from old.bulk_multiplier
     or new.min_order is distinct from old.min_order or new.paper_gsm is distinct from old.paper_gsm
     or new.pages_per_minute is distinct from old.pages_per_minute or new.handling_minutes is distinct from old.handling_minutes
     or new.is_listed is distinct from old.is_listed
     or new.opens_at is distinct from old.opens_at or new.closes_at is distinct from old.closes_at
     or new.hours is distinct from old.hours or new.closed_on is distinct from old.closed_on or new.tz is distinct from old.tz
     or new.upi_vpa is distinct from old.upi_vpa or new.upi_name is distinct from old.upi_name
     or new.upi_kind is distinct from old.upi_kind or new.upi_mc is distinct from old.upi_mc or new.upi_qr is distinct from old.upi_qr
     or new.accepts_cash is distinct from old.accepts_cash or new.round_to_rupee is distinct from old.round_to_rupee
     or new.shelf_rows is distinct from old.shelf_rows or new.shelf_cols is distinct from old.shelf_cols
     or new.extras is distinct from old.extras
     or new.low_paper_at is distinct from old.low_paper_at or new.low_toner_at is distinct from old.low_toner_at
     or new.max_pages_per_order is distinct from old.max_pages_per_order
     or new.unpaid_expiry_minutes is distinct from old.unpaid_expiry_minutes
     or new.unclaimed_after_hours is distinct from old.unclaimed_after_hours then
    raise exception 'Only the desk''s owner changes rates, payments, hours, extras and staff'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists operators_owner_guard on public.operators;
create trigger operators_owner_guard
  before update on public.operators
  for each row execute function public.guard_operator_owner();

-- ============================================================
-- 6. place_order: extras chosen must be the desk's; the snapshot carries them
-- ============================================================
create or replace function public.place_order(
  p_operator  uuid,
  p_items     jsonb,
  p_pickup_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me           text := public.clerk_id();
  op           public.operators;
  ps           public.platform_settings;
  item         jsonb;
  cfg          jsonb;
  first_cfg    jsonb;
  pg           integer;
  cp           integer;
  copies       integer;
  printed      integer := 0;
  pages_total  integer := 0;
  colour_total integer := 0;
  bulk         double precision;
  subtotal     numeric := 0;
  full_sum     numeric := 0;
  min_order    numeric;
  base         numeric;
  full_base    numeric;
  fee          numeric;
  full_fee     numeric;
  total        numeric;
  full_total   numeric;
  rounding     numeric := 0;
  recent       integer;
  new_id       uuid;
  doc          uuid;
  prices       numeric[] := '{}';
  x            text;
begin
  if me is null then
    raise exception 'Sign in to place an order';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order needs at least one file';
  end if;
  if jsonb_array_length(p_items) > 20 then
    raise exception 'At most 20 files in one order — split it in two';
  end if;

  select * into op from public.operators where id = p_operator and is_listed;
  if op.id is null then
    raise exception 'That operator is not taking orders';
  end if;
  select * into ps from public.platform_settings where id;

  if p_pickup_at is not null
     and (p_pickup_at < now() - interval '5 minutes' or p_pickup_at > now() + interval '30 days') then
    raise exception 'Pickup time is out of range';
  end if;

  select count(*) into recent
  from public.orders
  where user_id = me and created_at > now() - interval '1 hour';
  if recent >= 20 then
    raise exception 'That is a lot of orders in an hour. Try again shortly.'
      using errcode = 'check_violation';
  end if;

  for item in select value from jsonb_array_elements(p_items) loop
    cfg    := coalesce(item -> 'config', '{}'::jsonb);
    pg     := (item ->> 'pages')::integer;
    cp     := coalesce((item ->> 'colour_pages')::integer, 0);
    copies := coalesce((cfg ->> 'copies')::integer, 1);

    if pg is null or pg < 1 or pg > 5000 then
      raise exception 'Page count out of range';
    end if;
    if cp < 0 or cp > pg then
      raise exception 'Colour page count out of range';
    end if;
    if copies < 1 or copies > 200 then
      raise exception 'Copies out of range';
    end if;
    if coalesce(cfg ->> 'colour', 'smart') not in ('smart', 'bw', 'full')
       or coalesce(cfg ->> 'sides', 'double') not in ('single', 'double')
       or coalesce(cfg ->> 'binding', 'none') not in ('none', 'staple') then
      raise exception 'Unknown print setting';
    end if;
    -- Extras: each one the desk offers today, no repeats.
    if cfg ? 'extras' then
      if jsonb_typeof(cfg -> 'extras') <> 'array' then
        raise exception 'Unknown print setting';
      end if;
      for x in select jsonb_array_elements_text(cfg -> 'extras') loop
        if not exists (select 1 from jsonb_array_elements(coalesce(op.extras, '[]'::jsonb)) e where e ->> 'id' = x) then
          raise exception 'This desk doesn''t offer that extra any more — check the options';
        end if;
      end loop;
      if (select count(distinct v) from jsonb_array_elements_text(cfg -> 'extras') v)
         <> jsonb_array_length(cfg -> 'extras') then
        raise exception 'Unknown print setting';
      end if;
    end if;
    if length(coalesce(item ->> 'name', '')) not between 1 and 200 then
      raise exception 'File name missing or too long';
    end if;

    doc := nullif(item ->> 'document_id', '')::uuid;
    if doc is not null and not exists (
      select 1 from public.documents d where d.id = doc and d.user_id = me
    ) then
      raise exception 'That file is not yours';
    end if;

    printed := printed + pg * copies;
  end loop;

  bulk := case when printed >= coalesce(op.bulk_threshold, 100)
               then coalesce(op.bulk_multiplier, 0.92)::double precision
               else 1 end;
  min_order := public.to_paise(coalesce(op.min_order, 0)::double precision);

  for item in select value from jsonb_array_elements(p_items) loop
    cfg := coalesce(item -> 'config', '{}'::jsonb);
    pg  := (item ->> 'pages')::integer;
    cp  := coalesce((item ->> 'colour_pages')::integer, 0);

    prices   := prices || public.to_paise(public.price_line(pg, cp, cfg, op, bulk));
    subtotal := subtotal + prices[array_length(prices, 1)];
    full_sum := full_sum + public.to_paise(public.price_line(pg, pg, cfg || '{"colour":"full"}'::jsonb, op, bulk));

    pages_total  := pages_total + pg;
    colour_total := colour_total + cp;
    first_cfg    := coalesce(first_cfg, cfg);
  end loop;

  base      := greatest(subtotal, min_order);
  full_base := greatest(full_sum, min_order);
  fee       := public.platform_fee_for(base,      ps.fee_percent, ps.fee_min);
  full_fee  := public.platform_fee_for(full_base, ps.fee_percent, ps.fee_min);

  total      := base + fee;
  full_total := full_base + full_fee;
  if op.round_to_rupee then
    rounding   := ceil(total) - total;
    total      := ceil(total);
    full_total := ceil(full_total);
  end if;

  insert into public.orders (
    user_id, operator_id, total, full_colour_total, platform_fee, rounding, pages, colour_pages, config,
    pickup_mode, pickup_at, rate_card
  ) values (
    me, p_operator,
    total,
    full_total,
    fee,
    rounding,
    pages_total, colour_total, first_cfg,
    case when p_pickup_at is null then 'asap' else 'scheduled' end, p_pickup_at,
    jsonb_build_object(
      'currency',             op.currency,
      'bw_per_page',          op.bw_per_page,
      'colour_per_page',      op.colour_per_page,
      'duplex_discount',      op.duplex_discount,
      'staple_price',         op.staple_price,
      'bulk_threshold',       op.bulk_threshold,
      'bulk_multiplier',      op.bulk_multiplier,
      'min_order',            op.min_order,
      'paper_gsm',            op.paper_gsm,
      'platform_fee_percent', ps.fee_percent,
      'platform_fee_min',     ps.fee_min,
      'round_to_rupee',       op.round_to_rupee,
      'extras',               coalesce(op.extras, '[]'::jsonb)
    )
  )
  returning id into new_id;

  pg := 0;
  for item in select value from jsonb_array_elements(p_items) loop
    pg  := pg + 1;
    cfg := coalesce(item -> 'config', '{}'::jsonb);

    insert into public.order_items (
      order_id, document_id, name, pages, colour_pages, selected_pages, config, price, ordinal
    ) values (
      new_id,
      nullif(item ->> 'document_id', '')::uuid,
      item ->> 'name',
      (item ->> 'pages')::integer,
      coalesce((item ->> 'colour_pages')::integer, 0),
      coalesce(
        (select array_agg(x2::integer)
           from jsonb_array_elements_text(coalesce(item -> 'selected_pages', '[]'::jsonb)) x2),
        '{}'::integer[]
      ),
      cfg,
      prices[pg],
      pg
    );
  end loop;

  return new_id;
end;
$$;

-- ============================================================
-- 7. A corrected bill
-- ============================================================
alter table public.orders
  add column if not exists requote        jsonb,
  add column if not exists requote_status text;
alter table public.orders drop constraint if exists orders_requote_status_valid;
alter table public.orders add constraint orders_requote_status_valid
  check (requote_status is null or requote_status in ('proposed', 'accepted', 'withdrawn'));

/** A word to the student on their own order, by push and by WhatsApp where they have them. */
create or replace function public.notify_student(p_user text, p_order uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare
  prof public.profiles;
begin
  select * into prof from public.profiles where id = p_user;
  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail)
  values (
    p_user, p_order, 'whatsapp', prof.phone, p_body,
    case
      when prof.id is null then 'skipped'
      when coalesce(prof.notify_whatsapp, true) = false then 'skipped'
      when prof.phone is null or length(trim(prof.phone)) < 8 then 'skipped'
      else 'queued'
    end,
    case
      when prof.id is null then 'no profile row'
      when coalesce(prof.notify_whatsapp, true) = false then 'turned off in settings'
      when prof.phone is null or length(trim(prof.phone)) < 8 then 'no phone number saved'
      else null
    end
  );
  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail)
  values (
    p_user, p_order, 'push', null, p_body,
    case
      when prof.id is null then 'skipped'
      when coalesce(prof.notify_push, true) = false then 'skipped'
      when not exists (select 1 from public.push_subscriptions s where s.user_id = p_user) then 'skipped'
      else 'queued'
    end,
    case
      when prof.id is null then 'no profile row'
      when coalesce(prof.notify_push, true) = false then 'turned off in settings'
      when not exists (select 1 from public.push_subscriptions s where s.user_id = p_user) then 'no device subscribed'
      else null
    end
  );
end;
$$;

/**
 * Prices an order again from its own rate-card snapshot — the rates it
 * was placed under, not today's — with new page and colour counts for
 * some or all of its items. Returns the new figures without writing.
 */
drop function if exists public.reprice_order(uuid, jsonb);
create or replace function public.reprice_order(p_order uuid, p_items jsonb)
returns table (total numeric, platform_fee numeric, rounding numeric, pages integer, colour_pages integer, lines jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  o        public.orders;
  card     public.operators;
  it       record;
  given    jsonb;
  pg       integer;
  cp       integer;
  copies   integer;
  printed  integer := 0;
  bulk     double precision;
  min_ord  numeric;
  subtotal numeric := 0;
  base     numeric;
  fee      numeric;
  tot      numeric;
  rnd      numeric := 0;
  price    numeric;
  out_lines jsonb := '[]'::jsonb;
  pages_t  integer := 0;
  colour_t integer := 0;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null then raise exception 'No such order'; end if;
  if not (o.user_id = public.clerk_id() or public.is_staff(o.operator_id) or public.is_server()) then
    raise exception 'Not your order';
  end if;
  if o.rate_card is null then raise exception 'This order has no rate card to price from'; end if;
  card := jsonb_populate_record(null::public.operators, o.rate_card);

  for it in select oi.* from public.order_items oi where oi.order_id = p_order order by oi.ordinal loop
    given  := (select v from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) v where (v ->> 'item_id')::uuid = it.id limit 1);
    pg     := coalesce((given ->> 'pages')::integer, it.pages);
    cp     := coalesce((given ->> 'colour_pages')::integer, it.colour_pages);
    copies := greatest(coalesce((it.config ->> 'copies')::integer, 1), 1);
    if pg < 1 or pg > 5000 then raise exception 'Page count out of range'; end if;
    if cp < 0 or cp > pg then raise exception 'Colour page count out of range'; end if;
    printed := printed + pg * copies;
  end loop;

  bulk    := case when printed >= coalesce(card.bulk_threshold, 100)
                  then coalesce(card.bulk_multiplier, 0.92)::double precision else 1 end;
  min_ord := public.to_paise(coalesce(card.min_order, 0)::double precision);

  for it in select oi.* from public.order_items oi where oi.order_id = p_order order by oi.ordinal loop
    given := (select v from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) v where (v ->> 'item_id')::uuid = it.id limit 1);
    pg    := coalesce((given ->> 'pages')::integer, it.pages);
    cp    := coalesce((given ->> 'colour_pages')::integer, it.colour_pages);
    price := public.to_paise(public.price_line(pg, cp, it.config, card, bulk));
    subtotal  := subtotal + price;
    pages_t   := pages_t + pg;
    colour_t  := colour_t + cp;
    out_lines := out_lines || jsonb_build_object('item_id', it.id, 'pages', pg, 'colour_pages', cp, 'price', price);
  end loop;

  base := greatest(subtotal, min_ord);
  fee  := public.platform_fee_for(base, (o.rate_card ->> 'platform_fee_percent')::numeric, (o.rate_card ->> 'platform_fee_min')::numeric);
  tot  := base + fee;
  if coalesce((o.rate_card ->> 'round_to_rupee')::boolean, false) then
    rnd := ceil(tot) - tot;
    tot := ceil(tot);
  end if;

  return query select tot, fee, rnd, pages_t, colour_t, out_lines;
end;
$$;

/** The desk proposes corrected counts; nothing on the order changes until the student accepts. */
create or replace function public.propose_requote(p_order uuid, p_items jsonb, p_note text)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  o    public.orders;
  r    record;
  why  text := nullif(trim(coalesce(p_note, '')), '');
  op   public.operators;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'No such order'; end if;
  if not public.is_staff(o.operator_id) then raise exception 'Not your desk'; end if;
  if o.status <> 'placed' then
    raise exception 'A bill is corrected before the order is accepted';
  end if;
  if o.payment_taken_at is not null or o.gateway_paid_at is not null then
    raise exception 'This order is paid — the bill stands; take any difference in cash at the counter';
  end if;
  if why is null or length(why) > 120 then
    raise exception 'Say why, in up to 120 characters';
  end if;

  select * into r from public.reprice_order(p_order, p_items);
  if r.total = o.total and r.pages = o.pages and r.colour_pages = o.colour_pages then
    raise exception 'That''s the same bill';
  end if;

  perform set_config('printify.gateway', '1', true);
  update public.orders
     set requote = jsonb_build_object(
           'from', o.total, 'total', r.total, 'platform_fee', r.platform_fee, 'rounding', r.rounding,
           'pages', r.pages, 'colour_pages', r.colour_pages, 'lines', r.lines,
           'note', why, 'by', public.clerk_id(), 'at', now()),
         requote_status = 'proposed'
   where id = p_order;

  insert into public.order_events (order_id, status, actor, note)
  values (p_order, o.status, public.clerk_id(),
          'Bill corrected to ' || trim(to_char(r.total, 'FM999999990.00')) || ' — ' || why || ' — waiting for you to accept');

  select * into op from public.operators where id = o.operator_id;
  perform public.notify_student(o.user_id, p_order,
    coalesce(op.short_name, op.name, 'The desk') || ' corrected order ' || coalesce(o.token, '') || ' to '
    || coalesce(op.currency, '₹') || trim(to_char(r.total, 'FM999999990.00')) || ' (' || why || '). Open Printify to accept it.');

  return r.total;
end;
$$;

create or replace function public.withdraw_requote(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'No such order'; end if;
  if not public.is_staff(o.operator_id) then raise exception 'Not your desk'; end if;
  if o.requote_status is distinct from 'proposed' then raise exception 'There is no correction waiting'; end if;
  perform set_config('printify.gateway', '1', true);
  update public.orders set requote_status = 'withdrawn' where id = p_order;
  insert into public.order_events (order_id, status, actor, note)
  values (p_order, o.status, public.clerk_id(), 'Bill correction withdrawn — the original bill stands');
end;
$$;

/** The student takes the corrected bill: the order is re-priced from the proposal, to the paisa. */
create or replace function public.accept_requote(p_order uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  o public.orders;
  l jsonb;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'No such order'; end if;
  if o.user_id is distinct from public.clerk_id() then raise exception 'That order isn''t yours'; end if;
  if o.requote_status is distinct from 'proposed' then raise exception 'There is no correction waiting'; end if;
  if o.status <> 'placed' or o.payment_taken_at is not null or o.gateway_paid_at is not null then
    raise exception 'This order has moved on';
  end if;

  perform set_config('printify.gateway', '1', true);
  for l in select value from jsonb_array_elements(o.requote -> 'lines') loop
    update public.order_items
       set pages = (l ->> 'pages')::integer,
           colour_pages = (l ->> 'colour_pages')::integer,
           price = (l ->> 'price')::numeric
     where id = (l ->> 'item_id')::uuid and order_id = p_order;
  end loop;
  update public.orders
     set total          = (requote ->> 'total')::numeric,
         platform_fee   = (requote ->> 'platform_fee')::numeric,
         rounding       = (requote ->> 'rounding')::numeric,
         pages          = (requote ->> 'pages')::integer,
         colour_pages   = (requote ->> 'colour_pages')::integer,
         requote_status = 'accepted'
   where id = p_order;

  insert into public.order_events (order_id, status, actor, note)
  values (p_order, o.status, public.clerk_id(),
          'Corrected bill accepted: ' || trim(to_char((o.requote ->> 'total')::numeric, 'FM999999990.00')));
  return (o.requote ->> 'total')::numeric;
end;
$$;

-- ============================================================
-- 8. The order guard: the correction's columns, the owner's refunds,
--    and no accepting past a correction that's waiting
-- ============================================================
create or replace function public.guard_order_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('printify.gateway', true) = '1' then
    return new;
  end if;

  new.id                := old.id;
  new.user_id           := old.user_id;
  new.operator_id       := old.operator_id;
  new.token             := old.token;
  new.handover_code     := old.handover_code;
  new.created_at        := old.created_at;
  new.rate_card         := old.rate_card;
  new.total             := old.total;
  new.full_colour_total := old.full_colour_total;
  new.platform_fee      := old.platform_fee;
  new.rounding          := old.rounding;
  new.pages             := old.pages;
  new.colour_pages      := old.colour_pages;
  new.config            := old.config;
  new.requote           := old.requote;
  new.requote_status    := old.requote_status;
  new.gateway_order_id   := old.gateway_order_id;
  new.gateway_payment_id := old.gateway_payment_id;
  new.gateway_paid_at    := old.gateway_paid_at;
  new.fee_settled_at     := old.fee_settled_at;
  new.gateway_refund_id  := old.gateway_refund_id;
  new.gateway_split      := old.gateway_split;

  if public.is_staff(old.operator_id) then
    new.payment_method         := old.payment_method;
    new.payment_claimed_at     := old.payment_claimed_at;
    new.payment_claimed_amount := old.payment_claimed_amount;
    new.payment_reference      := old.payment_reference;
    -- A correction is waiting on the student: the desk withdraws it or waits.
    if old.requote_status = 'proposed' and new.status is distinct from old.status and new.status <> 'cancelled' then
      raise exception 'The corrected bill is waiting for the student — withdraw it to go ahead at the original price';
    end if;
    if (new.refunded_at is distinct from old.refunded_at
        or new.refund_amount is distinct from old.refund_amount
        or new.refund_note is distinct from old.refund_note)
       and not (public.is_owner(old.operator_id) or public.is_admin()) then
      raise exception 'Only the desk''s owner records a refund';
    end if;
    if new.status = 'queued' and old.status <> 'queued' then
      new.payment_taken_at := coalesce(new.payment_taken_at, now());
      new.payment_received := coalesce(new.payment_received, new.total);
    end if;
    if new.payment_received is not null
       and (new.payment_received < 0 or new.payment_received > 100000) then
      raise exception 'The amount received is out of range';
    end if;
    if new.refund_amount is not null
       and (new.refund_amount < 0 or new.refund_amount > new.total) then
      raise exception 'A refund is between nothing and the bill';
    end if;
    return new;
  end if;

  new.queued_at         := old.queued_at;
  new.pickup_mode       := old.pickup_mode;
  new.pickup_at         := old.pickup_at;
  new.is_priority       := old.is_priority;
  new.operator_note     := old.operator_note;
  new.payment_taken_at  := old.payment_taken_at;
  new.payment_received  := old.payment_received;
  new.shortfall_cleared_at := old.shortfall_cleared_at;
  new.shelf_slot        := old.shelf_slot;
  new.accepted_at       := old.accepted_at;
  new.started_at        := old.started_at;
  new.ready_at          := old.ready_at;
  new.collected_at      := old.collected_at;
  new.refunded_at       := old.refunded_at;
  new.refund_amount     := old.refund_amount;
  new.refund_note       := old.refund_note;
  new.cancelled_by      := old.cancelled_by;

  if old.payment_taken_at is not null then
    new.payment_method         := old.payment_method;
    new.payment_reference      := old.payment_reference;
    new.payment_claimed_amount := old.payment_claimed_amount;
    new.payment_claimed_at     := old.payment_claimed_at;
  end if;
  if new.payment_method = 'gateway' and old.payment_method is distinct from 'gateway' then
    raise exception 'A payment through Printify is recorded by Printify';
  end if;
  -- A corrected bill waits for a yes before any money is claimed against it.
  if old.requote_status = 'proposed' and new.payment_claimed_at is not null and old.payment_claimed_at is null then
    raise exception 'The desk corrected this bill — accept the new price first';
  end if;
  if new.payment_claimed_amount is not null
     and (new.payment_claimed_amount < 0 or new.payment_claimed_amount > 100000) then
    raise exception 'That amount is out of range';
  end if;

  if new.status is distinct from old.status then
    if new.status <> 'cancelled' then
      raise exception 'You can only cancel this order';
    end if;
    if old.status not in ('placed', 'queued') then
      raise exception 'Too late to cancel — the desk has started on it. Ask at the counter.';
    end if;
    new.cancelled_by := 'student';
  end if;

  return new;
end;
$$;

-- ============================================================
-- 9. Orders that go nowhere
-- ============================================================
/** The desk's housekeeping: unpaid orders past their window, ready orders nobody collected. */
create or replace function public.sweep_orders(p_operator uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  op public.operators;
  n  integer := 0;
  o  public.orders;
begin
  select * into op from public.operators where id = p_operator;
  if op.id is null then return 0; end if;
  if not (public.is_staff(p_operator) or public.is_server()) then
    raise exception 'Not your desk';
  end if;

  perform set_config('printify.gateway', '1', true);

  if op.unpaid_expiry_minutes > 0 then
    for o in
      select * from public.orders x
       where x.operator_id = p_operator and x.status = 'placed'
         and x.payment_claimed_at is null and x.gateway_paid_at is null and x.payment_taken_at is null
         and x.pickup_mode = 'asap'
         and x.created_at < now() - make_interval(mins => op.unpaid_expiry_minutes)
       for update skip locked
    loop
      update public.orders
         set status = 'cancelled', cancelled_by = 'system',
             note = 'Not paid within ' || op.unpaid_expiry_minutes || ' minutes — order again when you''re ready'
       where id = o.id;
      n := n + 1;
    end loop;
  end if;

  if op.unclaimed_after_hours > 0 then
    for o in
      select * from public.orders x
       where x.operator_id = p_operator and x.status = 'ready'
         and coalesce(x.ready_at, x.created_at) < now() - make_interval(hours => op.unclaimed_after_hours)
       for update skip locked
    loop
      update public.orders
         set status = 'unclaimed',
             note = 'Not collected within ' || op.unclaimed_after_hours || ' hours'
       where id = o.id;
      n := n + 1;
    end loop;
  end if;

  return n;
end;
$$;

/** Every desk, for the daily cron. */
create or replace function public.sweep_all_orders()
returns integer language plpgsql security definer set search_path = public as $$
declare
  d uuid;
  n integer := 0;
begin
  perform public.assert_server();
  for d in select id from public.operators loop
    n := n + public.sweep_orders(d);
  end loop;
  return n;
end;
$$;

-- Files go when the job is over, collected or not.
create or replace function public.schedule_document_purge()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('collected', 'unclaimed') and old.status not in ('collected', 'unclaimed') then
    update public.documents d
       set purge_at = now() + interval '6 hours'
     where d.id in (select oi.document_id from public.order_items oi where oi.order_id = new.id)
       and d.purge_at is null;
  end if;
  return new;
end;
$$;

-- The student hears about the two new endings.
create or replace function public.queue_order_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ord  public.orders;
  prof public.profiles;
  op   public.operators;
  msg  text;
  amt  text;
begin
  if new.status not in ('queued', 'ready', 'failed', 'collected', 'unclaimed', 'cancelled') then
    return new;
  end if;

  select * into ord from public.orders where id = new.order_id;
  if ord.id is null or ord.user_id is null then
    return new;
  end if;
  -- Cancelled by the student themselves needs no message; by the desk or
  -- the system, it does.
  if new.status = 'cancelled' and coalesce(new.actor, '') = ord.user_id then
    return new;
  end if;

  select * into prof from public.profiles  where id = ord.user_id;
  select * into op   from public.operators where id = ord.operator_id;

  amt := coalesce(op.currency, '₹')
      || case when ord.total = trunc(ord.total)
              then trim(to_char(ord.total, 'FM999999990'))
              else trim(to_char(ord.total, 'FM999999990.00')) end;

  msg := case new.status
    when 'queued'    then case when new.note like 'Paid online through Printify%'
                            then 'Paid ' || amt || ' online — order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printify') || '.'
                            else 'Order ' || coalesce(ord.token, '') || ' is in the queue at ' ||
                                 coalesce(op.short_name, op.name, 'Printify') || '.'
                          end
    when 'ready'     then 'Ready to collect. Show token ' || coalesce(ord.token, '') || ' at ' ||
                          coalesce(op.short_name, op.name, 'Printify') || '.'
    when 'collected' then 'Collected. Thanks!'
    when 'unclaimed' then 'Order ' || coalesce(ord.token, '') || ' wasn''t collected and has been cleared from the shelf at ' ||
                          coalesce(op.short_name, op.name, 'Printify') || '. Ask at the counter if you still need it.'
    when 'cancelled' then 'Order ' || coalesce(ord.token, '') || ' was cancelled' || coalesce(': ' || new.note, '') || '.'
    else 'We could not print your order' || coalesce(': ' || ord.note, '') || '.'
  end;

  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail)
  values (
    ord.user_id, new.order_id, 'whatsapp', prof.phone, msg,
    case
      when prof.id is null then 'skipped'
      when coalesce(prof.notify_whatsapp, true) = false then 'skipped'
      when prof.phone is null or length(trim(prof.phone)) < 8 then 'skipped'
      else 'queued'
    end,
    case
      when prof.id is null then 'no profile row'
      when coalesce(prof.notify_whatsapp, true) = false then 'turned off in settings'
      when prof.phone is null or length(trim(prof.phone)) < 8 then 'no phone number saved'
      else null
    end
  );

  insert into public.notifications (user_id, order_id, channel, to_phone, body, status, detail)
  values (
    ord.user_id, new.order_id, 'push', null, msg,
    case
      when prof.id is null then 'skipped'
      when coalesce(prof.notify_push, true) = false then 'skipped'
      when not exists (select 1 from public.push_subscriptions s where s.user_id = ord.user_id) then 'skipped'
      else 'queued'
    end,
    case
      when prof.id is null then 'no profile row'
      when coalesce(prof.notify_push, true) = false then 'turned off in settings'
      when not exists (select 1 from public.push_subscriptions s where s.user_id = ord.user_id)
        then 'no device subscribed'
      else null
    end
  );

  return new;
end;
$$;

-- Revenue counts what the desk was paid for, collected or left on the shelf.
drop function if exists public.operator_stats_range(uuid, timestamptz, timestamptz);
create or replace function public.operator_stats_range(p_operator uuid, p_from timestamptz, p_to timestamptz default now())
returns table (
  orders integer, collected integer, declined integer, pages integer, colour_pages integer,
  revenue numeric, refunded numeric, cash_total numeric, upi_total numeric, online_total numeric,
  uncollected integer, median_minutes integer, platform_fee numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_owner(p_operator) or public.is_admin() or public.is_server()) then return; end if;

  return query
  with mine as (
    select * from public.orders o
    where o.operator_id = p_operator and o.created_at >= p_from and o.created_at < p_to
  ), done as (
    select * from mine where mine.status in ('collected', 'unclaimed')
  )
  select
    (select count(*)::integer from mine),
    (select count(*)::integer from mine where mine.status = 'collected'),
    (select count(*)::integer from mine where mine.status in ('cancelled', 'failed')),
    (select coalesce(sum(done.pages), 0)::integer from done),
    (select coalesce(sum(done.colour_pages), 0)::integer from done),
    (select coalesce(sum(done.total), 0) from done),
    (select coalesce(sum(mine.refund_amount), 0) from mine where mine.refunded_at is not null),
    (select coalesce(sum(done.total), 0) from done where done.payment_method = 'cash'),
    (select coalesce(sum(done.total), 0) from done where done.payment_method = 'upi'),
    (select coalesce(sum(done.total), 0) from done where done.payment_method = 'gateway'),
    (select count(*)::integer from mine where mine.status = 'ready'),
    (select coalesce(percentile_cont(0.5) within group (
       order by extract(epoch from (mine.collected_at - mine.created_at)) / 60), 0)::integer
     from mine where mine.collected_at is not null),
    (select coalesce(sum(done.platform_fee), 0) from done
      where done.refund_amount is null or done.refund_amount < done.total);
end;
$$;

-- ============================================================
-- 10. The bucket takes what the desk can print
-- ============================================================
update storage.buckets
   set allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
 where id = 'documents';

-- ============================================================
-- 11. Grants (0036: nothing by default)
-- ============================================================
grant execute on function public.is_owner(uuid) to anon, authenticated;
grant execute on function public.create_invite(uuid, text, text) to authenticated;
grant execute on function public.list_staff(uuid) to authenticated;
grant execute on function public.add_staff(uuid, text, text) to authenticated;
grant execute on function public.set_staff_role(uuid, text, text) to authenticated;
grant execute on function public.propose_requote(uuid, jsonb, text) to authenticated;
grant execute on function public.withdraw_requote(uuid) to authenticated;
grant execute on function public.accept_requote(uuid) to authenticated;
grant execute on function public.reprice_order(uuid, jsonb) to authenticated;
grant execute on function public.sweep_orders(uuid) to authenticated;
-- Dropped and made again above, so their grants went with them (0036: none by default).
grant execute on function public.operator_wait(uuid) to anon, authenticated;
grant execute on function public.claim_invite(text) to authenticated;
grant execute on function public.fee_window(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.fee_balance(uuid) to authenticated;
grant execute on function public.fee_status(uuid) to authenticated;
grant execute on function public.payout_balance(uuid) to authenticated;
grant execute on function public.payout_window(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_fee_orders(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.operator_stats_range(uuid, timestamptz, timestamptz) to authenticated;
grant execute on all functions in schema public to service_role;
