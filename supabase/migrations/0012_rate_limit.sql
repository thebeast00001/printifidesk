-- Print Counter — an upload ceiling.
--
-- Nothing stopped one account uploading a thousand files or filling the bucket.
-- Enforced in the database rather than the UI, because the UI is not the only
-- way to reach the API.
--
-- Run after 0011.

alter table public.operators add column if not exists max_pages_per_order integer not null default 1000;

create or replace function public.enforce_upload_limits()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  recent  integer;
  stored  bigint;
begin
  select count(*) into recent
  from public.documents
  where user_id = new.user_id and created_at > now() - interval '1 hour';

  if recent >= 60 then
    raise exception 'That is a lot of uploads in an hour. Try again shortly.'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(size_bytes), 0) into stored
  from public.documents
  where user_id = new.user_id and purge_at is null;

  -- 500 MB of live documents per account. Collected jobs age out, so this is a
  -- ceiling on what one person can hold at once, not a lifetime quota.
  if stored + coalesce(new.size_bytes, 0) > 524288000 then
    raise exception 'You have 500 MB of files stored. Delete some from Settings first.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists documents_enforce_limits on public.documents;
create trigger documents_enforce_limits
  before insert on public.documents
  for each row execute function public.enforce_upload_limits();

-- ------------------------------------------------------------
-- Close the hole 0011 opened.
--
-- The guard pins each column a student may not change by name. 0011 added the
-- refund columns after it was written, so until now a student could have
-- written `refunded_at` on their own order and had the operator's takings
-- subtract money nobody ever sent. RLS grants the row, never the column — this
-- is the only thing standing between the two.
-- ------------------------------------------------------------

create or replace function public.guard_order_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Staff run the queue; they're allowed everything.
  if public.is_staff(new.operator_id) then
    if new.status = 'queued' and old.status <> 'queued' then
      new.payment_taken_at := coalesce(new.payment_taken_at, now());
    end if;
    return new;
  end if;

  -- Anyone else may only cancel, or record that they've paid.
  new.operator_id       := old.operator_id;
  new.user_id           := old.user_id;
  new.token             := old.token;
  new.total             := old.total;
  new.full_colour_total := old.full_colour_total;
  new.pages             := old.pages;
  new.colour_pages      := old.colour_pages;
  new.config            := old.config;
  new.pickup_mode       := old.pickup_mode;
  new.pickup_at         := old.pickup_at;
  new.is_priority       := old.is_priority;
  new.operator_note     := old.operator_note;
  new.payment_taken_at  := old.payment_taken_at;
  new.accepted_at       := old.accepted_at;
  new.started_at        := old.started_at;
  new.ready_at          := old.ready_at;
  new.collected_at      := old.collected_at;
  new.refunded_at       := old.refunded_at;
  new.refund_amount     := old.refund_amount;
  new.refund_note       := old.refund_note;

  -- The UPI reference is the student's to give, but only until the operator
  -- has checked it. After that it's evidence.
  if old.payment_taken_at is not null then
    new.payment_reference := old.payment_reference;
  end if;

  if new.status is distinct from old.status then
    if new.status <> 'cancelled' then
      raise exception 'You can only cancel this order';
    end if;
    new.cancelled_by := 'student';
  end if;

  return new;
end;
$$;
