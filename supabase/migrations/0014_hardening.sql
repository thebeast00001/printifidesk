-- Print Counter — the price is decided here, not in the browser.
--
-- A security pass over every trust boundary. Two of these are serious; the
-- rest are the kind of thing that costs nothing now and a lot later.
--
-- Run after 0013.

-- ============================================================
-- 1. The price of an order is computed by the database
-- ============================================================
-- Until now the browser worked out the total and inserted it, and the only
-- thing between a student and a ₹1 order for three hundred colour pages was the
-- operator noticing. `guard_order_update()` stopped the total being *changed*;
-- nothing stopped it being *wrong from the start*.
--
-- `place_order()` takes the files and their settings, prices them from the
-- operator's own rate card in the same arithmetic as `lib/pricing.ts`, and
-- writes the order and its items in one transaction. The direct insert
-- policies go away: there is no longer any path where a client supplies a
-- price.
--
-- What it still trusts from the client: the page count and colour-page count.
-- Those come from the file, which the server never opens. The operator sees
-- both on the card and confirms before printing, which is where a claimed
-- "10 pages" on a 300-page document gets caught.

/**
 * What one file costs before the order minimum. Mirrors `lineCost()` in
 * lib/pricing.ts, operation for operation.
 *
 * The arithmetic is done in double precision on purpose — that is IEEE 754,
 * the same number type the browser used to show the quote — so the figure the
 * student saw and the figure that gets stored agree to the rupee rather than
 * drifting at a .5 boundary because one side used exact decimals.
 */
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

  return (paper + bind) * copies;
end;
$$;

create or replace function public.place_order(
  p_operator  uuid,
  p_items     jsonb,
  p_pickup_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me           text := public.clerk_id();
  op           public.operators;
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
  raw          double precision := 0;
  full_raw     double precision := 0;
  min_order    numeric;
  recent       integer;
  new_id       uuid;
  doc          uuid;
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

  if p_pickup_at is not null
     and (p_pickup_at < now() - interval '5 minutes' or p_pickup_at > now() + interval '30 days') then
    raise exception 'Pickup time is out of range';
  end if;

  -- Twenty an hour is more than any student prints; a script does not get more.
  select count(*) into recent
  from public.orders
  where user_id = me and created_at > now() - interval '1 hour';
  if recent >= 20 then
    raise exception 'That is a lot of orders in an hour. Try again shortly.'
      using errcode = 'check_violation';
  end if;

  -- Pass one: validate every line, and count the pages that go through the
  -- machine — the bulk slab is a property of the whole job.
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
    if length(coalesce(item ->> 'name', '')) not between 1 and 200 then
      raise exception 'File name missing or too long';
    end if;

    -- A file on an order must be the caller's own. Without this a student
    -- could attach anyone's document id and hand the operator a signed URL
    -- for it — the file policy in 0011 grants staff whatever an order names.
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
  min_order := round(coalesce(op.min_order, 0));

  -- Pass two: price, summing in file order exactly as the browser does.
  for item in select value from jsonb_array_elements(p_items) loop
    cfg := coalesce(item -> 'config', '{}'::jsonb);
    pg  := (item ->> 'pages')::integer;
    cp  := coalesce((item ->> 'colour_pages')::integer, 0);

    raw      := raw      + public.price_line(pg, cp, cfg, op, bulk);
    full_raw := full_raw + public.price_line(pg, pg, cfg || '{"colour":"full"}'::jsonb, op, bulk);

    pages_total  := pages_total + pg;
    colour_total := colour_total + cp;
    first_cfg    := coalesce(first_cfg, cfg);
  end loop;

  insert into public.orders (
    user_id, operator_id, total, full_colour_total, pages, colour_pages, config,
    pickup_mode, pickup_at
  ) values (
    me, p_operator,
    greatest(round(raw::numeric),      min_order),
    greatest(round(full_raw::numeric), min_order),
    pages_total, colour_total, first_cfg,
    case when p_pickup_at is null then 'asap' else 'scheduled' end, p_pickup_at
  )
  returning id into new_id;

  for item in select value from jsonb_array_elements(p_items) loop
    cfg := coalesce(item -> 'config', '{}'::jsonb);
    pg  := (item ->> 'pages')::integer;
    cp  := coalesce((item ->> 'colour_pages')::integer, 0);

    insert into public.order_items (
      order_id, document_id, name, pages, colour_pages, selected_pages, config, price
    ) values (
      new_id,
      nullif(item ->> 'document_id', '')::uuid,
      item ->> 'name',
      pg, cp,
      coalesce(
        (select array_agg(x::integer)
           from jsonb_array_elements_text(coalesce(item -> 'selected_pages', '[]'::jsonb)) x),
        '{}'::integer[]
      ),
      cfg,
      round(public.price_line(pg, cp, cfg, op, bulk)::numeric)
    );
  end loop;

  return new_id;
end;
$$;

grant execute on function public.place_order(uuid, jsonb, timestamptz) to authenticated;
revoke execute on function public.place_order(uuid, jsonb, timestamptz) from anon;

-- No client writes a price any more. Reads, cancels and the staff policies are
-- untouched; only the two insert paths go.
drop policy if exists "orders insert"      on public.orders;
drop policy if exists "order items write"  on public.order_items;

-- ============================================================
-- 2. A document row can only point at its owner's file
-- ============================================================
-- The staff policy in 0011 lets an operator read any object a live order
-- names, and the row that names it was written by the student. Nothing tied
-- `storage_path` to `user_id`, so a row could point at somebody else's upload.
-- Not LIKE: Clerk ids contain underscores, and `_` is a LIKE wildcard.
alter table public.documents drop constraint if exists documents_path_owned;
alter table public.documents add constraint documents_path_owned
  check (left(storage_path, length(user_id) + 1) = user_id || '/');

alter table public.documents drop constraint if exists documents_counts_sane;
alter table public.documents add constraint documents_counts_sane
  check (
    pages between 0 and 5000
    and colour_pages between 0 and 5000
    and coalesce(size_bytes, 0) >= 0
    and length(name) between 1 and 200
  );

-- ============================================================
-- 3. Push endpoints
-- ============================================================
-- The server POSTs to whatever endpoint the browser stored. Only real push
-- services are https, and none of them live on a private address — so a row
-- pointing the server at one is not a subscription, it is a request to make
-- the server call something it shouldn't.
alter table public.push_subscriptions drop constraint if exists push_endpoint_sane;
alter table public.push_subscriptions add constraint push_endpoint_sane
  check (
    endpoint like 'https://%'
    and length(endpoint) <= 2048
    and endpoint !~* '^https://(localhost|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[::1\]|\[fc|\[fd|\[fe80)'
  );

-- Ten devices is generous. Past that the oldest goes, rather than the user
-- being refused — a stale laptop subscription shouldn't lock a phone out.
create or replace function public.cap_push_subscriptions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_subscriptions
  where id in (
    select id from public.push_subscriptions
    where user_id = new.user_id
    order by created_at desc
    offset 9
  );
  return new;
end;
$$;

drop trigger if exists push_subscriptions_cap on public.push_subscriptions;
create trigger push_subscriptions_cap
  before insert on public.push_subscriptions
  for each row execute function public.cap_push_subscriptions();

-- ============================================================
-- 4. Free text has a ceiling
-- ============================================================
-- Every one of these is rendered as text, never as HTML, so the risk is not
-- injection — it is a megabyte in a column that a card tries to display.
alter table public.orders drop constraint if exists orders_text_len;
alter table public.orders add constraint orders_text_len
  check (
    (payment_reference is null or length(payment_reference) <= 64)
    and (note          is null or length(note)          <= 500)
    and (operator_note is null or length(operator_note) <= 500)
    and (refund_note   is null or length(refund_note)   <= 200)
  );

alter table public.order_reports drop constraint if exists reports_text_len;
alter table public.order_reports add constraint reports_text_len
  check (
    length(reason) between 1 and 120
    and (detail     is null or length(detail)     <= 500)
    and (resolution is null or length(resolution) <= 200)
  );

alter table public.profiles drop constraint if exists profiles_text_len;
alter table public.profiles add constraint profiles_text_len
  check (
    (name       is null or length(name)       <= 120)
    and (phone      is null or length(phone)      <= 32)
    and (roll_no    is null or length(roll_no)    <= 40)
    and (department is null or length(department) <= 80)
    and (hostel     is null or length(hostel)     <= 80)
    and (room       is null or length(room)       <= 40)
    and (year       is null or length(year)       <= 20)
    and (avatar_url is null or (avatar_url like 'https://%' and length(avatar_url) <= 1024))
  );

alter table public.operator_applications drop constraint if exists applications_text_len;
alter table public.operator_applications add constraint applications_text_len
  check (
    length(display_name) between 1 and 120
    and length(campus) between 1 and 120
    and (location is null or length(location) <= 200)
    and length(phone) between 1 and 32
    and (machine is null or length(machine) <= 200)
    and (note    is null or length(note)    <= 1000)
  );

-- ============================================================
-- 5. Re-subscribing to push must not fail
-- ============================================================
-- `enablePush()` upserts on the endpoint. With no UPDATE policy, the conflict
-- branch is refused by RLS — so turning push on a second time from the same
-- browser errored. The policy is scoped to the owner, which also means one
-- user can never take over an endpoint that belongs to another.
drop policy if exists "own push update" on public.push_subscriptions;
create policy "own push update" on public.push_subscriptions for update
  using (user_id = public.clerk_id())
  with check (user_id = public.clerk_id());
