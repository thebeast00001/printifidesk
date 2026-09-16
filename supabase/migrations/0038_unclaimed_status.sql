-- Printify — 0038: one new order status, on its own.
--
-- Run after 0037, and run 0039 separately afterwards. A new enum value
-- can't be used in the transaction that adds it, and 0039's functions
-- name it — so this is its own paste, its own run.
--
-- 'unclaimed': printed, marked ready, and never collected within the
-- desk's window. The shelf slot frees, the files purge, the desk keeps
-- what it was paid — it did the work.
alter type public.order_status add value if not exists 'unclaimed';
