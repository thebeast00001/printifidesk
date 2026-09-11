#!/usr/bin/env bash
# Runs every migration, in order, against a throwaway Postgres.
#
# Catches what static review keeps missing: reserved words, parameter renames
# that CREATE OR REPLACE can't do, policies that depend on a function being
# dropped, columns referenced before they exist.
#
#   ./scripts/verify-migrations.sh
set -euo pipefail

CONTAINER=printcounter-migration-check
IMAGE=postgres:16-alpine
PASSWORD=verify

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "→ starting $IMAGE"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD="$PASSWORD" "$IMAGE" >/dev/null

until docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

run() {
  local file=$1
  echo "→ $(basename "$file")"
  # ON_ERROR_STOP makes psql exit non-zero on the first failure, and -1 wraps
  # each file in a transaction so a failure can't leave a half-applied schema.
  docker exec -i "$CONTAINER" psql -U postgres -d postgres \
    -v ON_ERROR_STOP=1 -1 -q < "$file"
}

run supabase/test/00_supabase_stubs.sql
for m in supabase/migrations/*.sql; do run "$m"; done

echo "→ re-running migrations (they must be idempotent)"
for m in supabase/migrations/*.sql; do run "$m"; done

echo "→ smoke-testing the functions"
docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
insert into auth.jwt_override (claims)
values ('{"sub":"user_test123","role":"authenticated"}'::jsonb);

-- A profile, an operator and an order, the way the app creates them.
insert into public.profiles (id, email, name) values ('user_test123', 'a@b.c', 'Test');

insert into public.orders (user_id, operator_id, total, full_colour_total, pages, colour_pages, config)
select 'user_test123', id, 55, 79, 6, 2, '{"copies":1}'::jsonb from public.operators limit 1;

do $$
declare
  o uuid;
  t text;
  ev integer;
  q record;
  w record;
begin
  select id, token into o, t from public.orders limit 1;
  if t is null then raise exception 'token trigger did not fire'; end if;

  select count(*) into ev from public.order_events where order_id = o;
  if ev <> 1 then raise exception 'expected 1 timeline event, got %', ev; end if;

  -- Status change must append a second event and stamp queued_at.
  update public.orders set status = 'queued' where id = o;
  select count(*) into ev from public.order_events where order_id = o;
  if ev <> 2 then raise exception 'status change did not append an event, got %', ev; end if;

  select * into q from public.queue_status(o);
  if q.place is null then raise exception 'queue_status returned no row'; end if;

  select * into w from public.operator_wait((select id from public.operators limit 1));
  if w.open is null then raise exception 'operator_wait returned no row'; end if;
  if w.open then raise exception 'operator should default to closed'; end if;

  -- Opening it must flip what students see.
  update public.operators set is_open = true;
  select * into w from public.operator_wait((select id from public.operators limit 1));
  if not w.open then raise exception 'operator_wait ignored is_open'; end if;

  raise notice 'token=% events=% place=% wait=%min pending=%',
    t, ev, q.place, w.wait_minutes, w.pending_orders;
end $$;

select 'my_totals' as fn, * from public.my_totals();
select 'whoami' as fn, * from public.whoami();
SQL

echo
echo "✓ all migrations applied, re-applied, and behaved"
