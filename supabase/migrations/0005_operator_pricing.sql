-- Print Counter — each operator sets their own prices.
--
-- Rates used to be a constant in the app, which only works if every operator
-- charges the same. They don't: a hostel desk and a library desk have different
-- paper costs, different machines and different competition. So the rate card
-- moves onto the operator row, and the operator edits it from their own page.
--
-- Binding also shrinks to what a desk actually does on the spot — staple or
-- leave it loose. Spiral and soft binding are a separate job with a separate
-- turnaround, so they're out until they're modelled properly.
--
-- Run after 0004.

alter table public.operators add column if not exists currency         text          not null default '₹';
alter table public.operators add column if not exists bw_per_page      numeric(10,2) not null default 1.50;
alter table public.operators add column if not exists colour_per_page  numeric(10,2) not null default 8.00;
-- Share taken off when both sides of the sheet are used, 0–1.
alter table public.operators add column if not exists duplex_discount  numeric(4,3)  not null default 0.08;
alter table public.operators add column if not exists staple_price     numeric(10,2) not null default 5.00;
-- One volume slab: at or above this many pages, multiply the paper cost.
alter table public.operators add column if not exists bulk_threshold   integer       not null default 100;
alter table public.operators add column if not exists bulk_multiplier  numeric(4,3)  not null default 0.92;
alter table public.operators add column if not exists paper_gsm        integer       not null default 80;
-- Smallest amount worth running the machine for.
alter table public.operators add column if not exists min_order        numeric(10,2) not null default 0;

-- Keep the values sane no matter what the editor sends.
do $$ begin
  alter table public.operators add constraint operators_rates_sane check (
    bw_per_page      >= 0 and
    colour_per_page  >= 0 and
    staple_price     >= 0 and
    min_order        >= 0 and
    duplex_discount  >= 0 and duplex_discount  <= 0.9 and
    bulk_multiplier  >  0 and bulk_multiplier  <= 1 and
    bulk_threshold   >= 1 and
    pages_per_minute >= 1
  );
exception when duplicate_object then null;
end $$;

-- Existing orders keep whatever binding they were placed with; only new ones
-- are limited to the two the sheet now offers.
comment on column public.orders.config is
  'Snapshot of the print options at order time: colour, sides, binding, copies.';

-- Rates are public: a student has to see the price before they sign in.
-- The existing "operators are public" select policy already covers this.
