-- Empties every Printify table. Not a migration: nothing about the schema,
-- the policies or the functions changes, and it is never applied by anything
-- automatic. Paste it into Supabase → SQL Editor when you want a clean slate.
--
-- Every table is named rather than looped over, so what this deletes is
-- readable before it runs. `npm run check:sql` asserts that this list and the
-- tables the migrations create are the same set, so a table added later can't
-- be quietly left full.
--
-- Two things it cannot reach, and where they live:
--   * The files themselves. Storage → documents → select all → Delete.
--     (Deleting rows from storage.objects here would leave the bytes behind.)
--   * The accounts. Users are Clerk's: Clerk dashboard → Users. Left alone,
--     the same Google sign-in gets the same id back and a fresh profile row —
--     which is fine if "fresh" means the data and not the people.
--
-- Afterwards a paired counter device holds a token this database no longer
-- knows; it will say so and offer "Forget this pairing".
--
-- One table is deliberately left alone, and `check:sql` knows it is:
-- keeps public.platform_settings — the fee percentage and the payee VPA are
-- configuration, not data, and a reset shouldn't make the admin set them
-- again.

truncate table
  public.order_reports,
  public.order_messages,
  public.order_events,
  public.order_items,
  public.document_access_log,
  public.notifications,
  public.push_subscriptions,
  public.orders,
  public.documents,
  public.token_sequence,
  public.stock_log,
  public.desk_closeouts,
  public.desk_devices,
  public.staff_pins,
  public.staff_invites,
  public.invite_attempts,
  public.platform_settlements,
  public.platform_payouts,
  public.operator_applications,
  public.staff,
  public.operators,
  public.admins,
  public.profiles
restart identity cascade;
