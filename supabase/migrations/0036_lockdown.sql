-- Printifi — 0036: the grants say what the guards already say.
--
-- Run after 0035.
--
-- A review of the whole surface — student site, desk site, admin — against
-- what the database actually allowed, as opposed to what the app uses.
-- Nothing here changes what the app does; it closes the gaps between the
-- two. In order of weight:
--
-- 1. Every function in `public` was executable by anyone holding the anon
--    key. Postgres grants EXECUTE to PUBLIC on every new function, and every
--    `revoke … from anon` before this one left that grant in place — anon
--    inherits from PUBLIC. Most functions gate themselves (is_admin(),
--    is_staff(), clerk_id()), so the door was locked twice; two did not:
--    claim_notifications() and complete_notification(), the notification
--    queue's server-only pair. Through PostgREST they handed anyone the
--    queued rows — phone numbers and message bodies — and let them be
--    marked sent. From here on PUBLIC, anon and authenticated hold nothing
--    by default, on existing functions and on future ones, and each
--    function is granted to exactly who calls it. check:sql asserts the
--    whole matrix, as the anon and authenticated roles, so a function
--    added without a grant fails there instead of in production.
-- 2. token_sequence had no RLS and Supabase's default table grants:
--    readable and writable by anyone. RLS with no policies — only the token
--    trigger (security definer) touches it.
-- 3. operators.gateway_* were the desk's to write: its staff could switch
--    on "pay through Printifi" for their own desk. Pinned to the admin and
--    the server, the way shut_* already were.
-- 4. The order guard pins more. A student could back-date an order — the
--    queue is in created_at order — and staff could rewrite the bill, the
--    owner, the desk, or the student's own claim. Neither can now. A staff
--    refund is between nothing and the bill.
-- 5. queue_status(): `o.user_id <> clerk_id()` is null when clerk_id() is,
--    and a null condition doesn't return — so a caller with a guessed uuid
--    and no session got the queue place. `is distinct from`.
-- 6. profiles: the update policy gains WITH CHECK so a row can't be renamed
--    to another id.
-- 7. order_messages / order_reports: a student marks a message read and
--    nothing else; a report's words are its author's once filed.

-- ============================================================
-- 1a. The server, as a question
-- ============================================================
-- assert_server() raises; the operators guard needs the same test as a
-- boolean, alongside is_admin().
create or replace function public.is_server()
returns boolean language sql stable as $$
  select public.clerk_id() is null
     and (auth.jwt() is null or coalesce(auth.jwt() ->> 'role', '') = 'service_role');
$$;

-- ============================================================
-- 1b. The notification queue is the server's, in the body as well
-- ============================================================
create or replace function public.claim_notifications(p_limit integer default 20)
returns setof public.notifications
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_server();
  return query
  update public.notifications n
     set status = 'sending'
   where n.id in (
     select id from public.notifications
      where status = 'queued'
      order by created_at
      limit greatest(p_limit, 1)
      for update skip locked
   )
  returning n.*;
end;
$$;

create or replace function public.complete_notification(
  p_id bigint, p_status text, p_detail text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_server();
  update public.notifications
     set status = p_status, detail = p_detail, completed_at = now()
   where id = p_id;
end;
$$;

-- ============================================================
-- 2. token_sequence: the trigger's, nobody else's
-- ============================================================
alter table public.token_sequence enable row level security;
revoke all on table public.token_sequence from public, anon, authenticated;

-- ============================================================
-- 3. Online payment is switched on by Printifi, not by the desk
-- ============================================================
create or replace function public.guard_operator_shut()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Not the desk's to change: who it is, when it was made.
  new.id         := old.id;
  new.created_at := old.created_at;

  if (new.shut_at     is distinct from old.shut_at
   or new.shut_reason is distinct from old.shut_reason
   or new.shut_by     is distinct from old.shut_by)
     and not public.is_admin() then
    raise exception 'Only the admin shuts or restores a desk' using errcode = 'check_violation';
  end if;
  if (new.gateway_vendor_id  is distinct from old.gateway_vendor_id
   or new.gateway_status     is distinct from old.gateway_status
   or new.gateway_checked_at is distinct from old.gateway_checked_at)
     and not (public.is_admin() or public.is_server()) then
    raise exception 'Only Printifi switches online payment for a desk' using errcode = 'check_violation';
  end if;
  if new.shut_at is not null and not public.is_admin() then
    if new.is_open and not old.is_open then
      raise exception 'This desk was closed by Printifi: %', old.shut_reason
        using errcode = 'check_violation';
    end if;
    if new.is_listed and not old.is_listed then
      raise exception 'This desk was closed by Printifi and cannot be listed'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

-- ============================================================
-- 4. The order guard
-- ============================================================
create or replace function public.guard_order_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('printify.gateway', true) = '1' then
    return new;
  end if;

  -- What nobody in a browser rewrites, staff or student: whose it is, where
  -- it is, when it was placed, and the bill the database priced.
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
  new.gateway_order_id   := old.gateway_order_id;
  new.gateway_payment_id := old.gateway_payment_id;
  new.gateway_paid_at    := old.gateway_paid_at;
  new.fee_settled_at     := old.fee_settled_at;
  new.gateway_refund_id  := old.gateway_refund_id;
  new.gateway_split      := old.gateway_split;

  if public.is_staff(old.operator_id) then
    -- The student's claim is the student's; the desk answers it with its
    -- own fields (payment_received, shortfall_cleared_at).
    new.payment_method         := old.payment_method;
    new.payment_claimed_at     := old.payment_claimed_at;
    new.payment_claimed_amount := old.payment_claimed_amount;
    new.payment_reference      := old.payment_reference;
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

  -- A student: their claim, their note, and one status change — to cancelled.
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
  -- "Paid online" is the server's word, never a claim.
  if new.payment_method = 'gateway' and old.payment_method is distinct from 'gateway' then
    raise exception 'A payment through Printifi is recorded by Printifi';
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
-- 5. queue_status: a null id is nobody, not everybody
-- ============================================================
create or replace function public.queue_status(p_order uuid)
returns table (place integer, pages_ahead integer, wait_minutes integer)
language plpgsql stable security definer set search_path = public as $$
declare
  o public.orders;
  c public.operators;
  ahead integer;
  pos integer;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null then return; end if;
  if o.user_id is distinct from public.clerk_id() and not public.is_staff(o.operator_id) then return; end if;

  select * into c from public.operators where id = o.operator_id;

  select count(*), coalesce(sum(q.pages), 0)
    into pos, ahead
  from public.orders q
  where q.operator_id = o.operator_id
    and q.status in ('queued', 'printing', 'finishing')
    and q.created_at < o.created_at;

  return query select
    pos + 1,
    ahead,
    ceil((ahead + o.pages)::numeric / greatest(c.pages_per_minute, 1))::integer
      + c.handling_minutes;
end;
$$;

-- ============================================================
-- 6. A profile keeps its id
-- ============================================================
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles for update
  using (id = public.clerk_id())
  with check (id = public.clerk_id());

-- ============================================================
-- 7. Messages and reports keep their words
-- ============================================================
-- The only update a student may make to a message is reading it; the
-- policy says who, this says what.
create or replace function public.guard_message_update()
returns trigger language plpgsql as $$
begin
  new.id         := old.id;
  new.order_id   := old.order_id;
  new.sender     := old.sender;
  new.body       := old.body;
  new.created_at := old.created_at;
  return new;
end;
$$;
drop trigger if exists order_messages_guard on public.order_messages;
create trigger order_messages_guard
  before update on public.order_messages
  for each row execute function public.guard_message_update();

-- A report is resolved by the desk; what the student wrote stays written.
create or replace function public.guard_report_update()
returns trigger language plpgsql as $$
begin
  new.id         := old.id;
  new.order_id   := old.order_id;
  new.user_id    := old.user_id;
  new.reason     := old.reason;
  new.detail     := old.detail;
  new.created_at := old.created_at;
  return new;
end;
$$;
drop trigger if exists order_reports_guard on public.order_reports;
create trigger order_reports_guard
  before update on public.order_reports
  for each row execute function public.guard_report_update();

-- ============================================================
-- 8. Functions: nothing by default, each granted to who calls it
-- ============================================================
-- Trigger functions are left alone: a trigger fires whatever the caller's
-- privileges (checked in check:sql), and PostgREST never exposes them.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_type t on t.oid = p.prorettype
     where n.nspname = 'public' and p.prokind = 'f' and t.typname <> 'trigger'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- Future functions start the same way: no PUBLIC, no anon, no authenticated.
-- The server keeps its default. Two levels, because that's how Postgres
-- stores them: the PUBLIC grant is the global built-in default, and a
-- per-schema entry is merged *onto* the global one — so revoking PUBLIC
-- per schema does nothing (ALTER DEFAULT PRIVILEGES, "Notes"). Supabase's
-- grant to anon and authenticated is per schema, and is taken back there.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public grant execute on functions to service_role;
grant execute on all functions in schema public to service_role;

-- Policies evaluate these as whoever is asking, so both roles need them;
-- each is a yes/no about the caller's own token.
grant execute on function public.clerk_id() to anon, authenticated;
grant execute on function public.is_staff(uuid) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- Signed out: the counter's wait, the board, a paired device's front door.
grant execute on function public.operator_wait(uuid) to anon, authenticated;
grant execute on function public.board(uuid) to anon, authenticated;
grant execute on function public.desk_staff(text) to anon, authenticated;
grant execute on function public.desk_verify_pin(text, text, text) to anon, authenticated;
grant execute on function public.whoami() to anon, authenticated;

-- Signed in. Each of these checks is_admin()/is_staff()/clerk_id() itself.
grant execute on function public.queue_status(uuid) to authenticated;
grant execute on function public.queue_status_mine() to authenticated;
grant execute on function public.my_totals() to authenticated;
grant execute on function public.place_order(uuid, jsonb, timestamptz) to authenticated;
grant execute on function public.claim_document_access(uuid, text) to authenticated;
grant execute on function public.operator_stats(uuid) to authenticated;
grant execute on function public.operator_stats_range(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.adjust_stock(uuid, integer, integer, text) to authenticated;
grant execute on function public.list_staff(uuid) to authenticated;
grant execute on function public.add_staff(uuid, text) to authenticated;
grant execute on function public.remove_staff(uuid, text) to authenticated;
grant execute on function public.close_desk(uuid, numeric, text) to authenticated;
grant execute on function public.set_my_pin(uuid, text) to authenticated;
grant execute on function public.pair_device(uuid, text) to authenticated;
grant execute on function public.revoke_device(uuid) to authenticated;
grant execute on function public.create_invite(uuid, text) to authenticated;
grant execute on function public.claim_invite(text) to authenticated;
grant execute on function public.revoke_invite(uuid) to authenticated;
grant execute on function public.create_operator(text, text) to authenticated;
grant execute on function public.admin_desks() to authenticated;
grant execute on function public.admins_exist() to authenticated;
grant execute on function public.set_platform_fee(numeric, numeric, text, text, integer, text) to authenticated;
grant execute on function public.record_settlement(uuid, numeric, text) to authenticated;
grant execute on function public.fee_window(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.fee_balance(uuid) to authenticated;
grant execute on function public.fee_status(uuid) to authenticated;
grant execute on function public.admin_fee_desks(timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_fee_orders(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.apply_for_desk(text, text, text, text, text, text) to authenticated;
grant execute on function public.withdraw_application(uuid) to authenticated;
grant execute on function public.approve_application(uuid, text) to authenticated;
grant execute on function public.reject_application(uuid, text) to authenticated;
grant execute on function public.my_application() to authenticated;
grant execute on function public.admin_applications(text) to authenticated;
grant execute on function public.shut_operator(uuid, text) to authenticated;
grant execute on function public.restore_operator(uuid) to authenticated;
grant execute on function public.payout_balance(uuid) to authenticated;
grant execute on function public.payout_window(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.record_payout(uuid, numeric, text) to authenticated;
grant execute on function public.admin_payout_desks(timestamptz, timestamptz) to authenticated;
grant execute on function public.set_gateway_collect(uuid, boolean) to authenticated;

-- Server only — the service role has them from the grant above:
--   claim_notifications, complete_notification,
--   gateway_begin, gateway_paid, gateway_refunded.
-- Internal only — called from definer bodies, which run as their owner:
--   assert_server, is_server, can_invite_for, new_join_code, pin_digest,
--   platform_fee_for, price_line, to_paise, desk_share.
