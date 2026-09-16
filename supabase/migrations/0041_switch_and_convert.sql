-- Printify — 0041: the switch wins until the schedule's next change; any
-- file converts to a PDF.
--
-- Run after 0040.
--
-- 1. The Open switch and the hours. 0039 made "open" the switch AND the
--    schedule — so an owner who opened the shop early and tapped Open was
--    still shown as closed until the hours said otherwise. Now the
--    schedule is the default and a tap is a person's decision that holds
--    until the schedule's next change: open at 8:30 with hours from 9 →
--    open now, and closed at 6 by the hours as usual; closed at 3 with
--    hours to 6 → closed now, open again tomorrow at 9 by the hours.
--    `open_set_at` is when the switch was last flipped; `operator_open_at()`
--    compares it with the most recent scheduled boundary.
-- 2. Documents of any kind. Office files (Word, PowerPoint, Excel, text)
--    are uploaded as they are and converted to PDF by the server (see
--    /api/convert); the bucket takes them, and a student's own row can be
--    given exact page and colour counts once the PDF has been measured.

-- ============================================================
-- 1. The switch wins until the schedule's next change
-- ============================================================
alter table public.operators
  add column if not exists open_set_at timestamptz;

-- Stamp the flip, not the note: a note edited at night must not reopen the desk.
create or replace function public.touch_operator_status()
returns trigger language plpgsql as $$
begin
  if new.is_open is distinct from old.is_open
     or new.status_note is distinct from old.status_note then
    new.status_changed_at := now();
  end if;
  if new.is_open is distinct from old.is_open then
    new.open_set_at := now();
  end if;
  return new;
end;
$$;

/**
 * The most recent moment the schedule changed state at or before p_at —
 * an opening or a closing, from the weekly hours (or the flat
 * opens_at–closes_at). Days marked closed contribute no boundary of their
 * own; the previous close stands. Null when the desk has no hours at all.
 */
create or replace function public.operator_last_boundary(p_op public.operators, p_at timestamptz)
returns timestamptz language plpgsql stable as $$
declare
  zone     text := coalesce(nullif(p_op.tz, ''), 'Asia/Kolkata');
  local_ts timestamp := p_at at time zone zone;
  days     text[] := array['mon','tue','wed','thu','fri','sat','sun'];
  d        integer;
  day_date date;
  entry    jsonb;
  opens    time;
  closes   time;
  open_ts  timestamptz;
  close_ts timestamptz;
  best     timestamptz := null;
begin
  for d in 0..8 loop
    day_date := (local_ts::date - d);
    if day_date = any (coalesce(p_op.closed_on, '{}')) then continue; end if;
    if p_op.hours is null or jsonb_typeof(p_op.hours) <> 'object' then
      opens  := p_op.opens_at;
      closes := p_op.closes_at;
    else
      entry := p_op.hours -> days[extract(isodow from day_date)::integer];
      if entry is null or jsonb_typeof(entry) <> 'object' then continue; end if;
      opens  := (entry ->> 'open')::time;
      closes := (entry ->> 'close')::time;
    end if;
    if opens is null or closes is null then continue; end if;
    open_ts  := (day_date + opens) at time zone zone;
    close_ts := (day_date + closes) at time zone zone;
    if closes <= opens then close_ts := close_ts + interval '1 day'; end if;
    if open_ts <= p_at and (best is null or open_ts > best) then best := open_ts; end if;
    if close_ts <= p_at and (best is null or close_ts > best) then best := close_ts; end if;
  end loop;
  return best;
end;
$$;

/** What the schedule alone says at p_at — the hours, the closed days; not the switch, not the admin. */
create or replace function public.operator_scheduled_at(p_op public.operators, p_at timestamptz)
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
  if local_ts::date = any (coalesce(p_op.closed_on, '{}')) then return false; end if;

  if p_op.hours is null or jsonb_typeof(p_op.hours) <> 'object' then
    if p_op.opens_at is null or p_op.closes_at is null then return true; end if;
    if p_op.closes_at > p_op.opens_at then
      return t >= p_op.opens_at and t < p_op.closes_at;
    end if;
    return t >= p_op.opens_at or t < p_op.closes_at;
  end if;

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

/**
 * The one answer to "is this desk open at this moment". Shut by the admin:
 * no. Otherwise the switch, if it was flipped since the schedule last
 * changed state; otherwise the schedule. A desk with no hours at all is
 * its switch alone, as it was before 0039.
 */
create or replace function public.operator_open_at(p_op public.operators, p_at timestamptz)
returns boolean language plpgsql stable as $$
declare
  boundary timestamptz;
begin
  if p_op.shut_at is not null then return false; end if;
  boundary := public.operator_last_boundary(p_op, p_at);
  if boundary is null then return p_op.is_open; end if;
  if p_op.open_set_at is not null and p_op.open_set_at > boundary then
    return p_op.is_open;
  end if;
  return public.operator_scheduled_at(p_op, p_at);
end;
$$;

-- ============================================================
-- 2. Documents of any kind
-- ============================================================
update storage.buckets
   set allowed_mime_types = array[
     'application/pdf',
     'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-powerpoint',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.oasis.opendocument.text',
     'application/vnd.oasis.opendocument.presentation',
     'application/vnd.oasis.opendocument.spreadsheet',
     'application/rtf', 'text/plain'
   ]
 where id = 'documents';

/**
 * The exact counts, once the converted PDF has been measured in the
 * student's own browser — pages and which carry colour. Their own document,
 * and only while it isn't on an order yet: an order's counts are the
 * order's, and a correction to them is the desk's (0039).
 */
create or replace function public.set_document_analysis(p_document uuid, p_pages integer, p_colour_index integer[])
returns void language plpgsql security definer set search_path = public as $$
declare
  d public.documents;
begin
  select * into d from public.documents where id = p_document;
  if d.id is null then raise exception 'No such file'; end if;
  if d.user_id is distinct from public.clerk_id() then raise exception 'Not your file'; end if;
  if exists (select 1 from public.order_items oi where oi.document_id = p_document) then
    raise exception 'This file is already on an order';
  end if;
  if p_pages is null or p_pages < 1 or p_pages > 5000 then raise exception 'Page count out of range'; end if;
  if coalesce(array_length(p_colour_index, 1), 0) > p_pages then raise exception 'Colour page count out of range'; end if;
  update public.documents
     set pages = p_pages,
         colour_pages = coalesce(array_length(p_colour_index, 1), 0),
         colour_index = coalesce(p_colour_index, '{}'),
         pages_exact = true
   where id = p_document;
end;
$$;

grant execute on function public.set_document_analysis(uuid, integer, integer[]) to authenticated;
grant execute on all functions in schema public to service_role;
