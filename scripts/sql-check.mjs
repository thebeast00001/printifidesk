// Actually runs the migrations.
//
// `check:migrations` needs Docker, and Docker has never started on the machine
// this was built on — so for a long stretch the migrations were only ever read,
// never executed, and three separate errors reached the Supabase SQL editor
// before anyone noticed. PGlite is real Postgres compiled to WebAssembly: same
// parser, same PL/pgSQL, no daemon. That's enough to catch every one of them.
//
// What it cannot check is whether the RLS policies grant the right rows. The
// JWT claim is set the way PostgREST sets it, so `clerk_id()` and `is_staff()`
// are the real functions — but PGlite runs as superuser and superusers bypass
// RLS. So this proves the SQL is valid, applies, and that the triggers behave;
// it does not prove a policy is correct. The note printed at the end says the
// same thing, so a green run can't be mistaken for more than it is.

import { PGlite } from "@electric-sql/pglite";
// Run under tsx (see package.json) so the real pricing engine can be imported
// and the SQL port checked against it, rather than against a copy of it.
import { quoteOrder, rateCardOf } from "../lib/pricing";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "supabase", "migrations");

/**
 * The parts of a Supabase project the migrations lean on. Deliberately minimal
 * and deliberately real shapes — `storage.objects.name` is the column the file
 * policy matches on, so getting it wrong here would hide a genuine error.
 */
const SUPABASE_STUB = `
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
-- No pgcrypto: PGlite doesn't ship it, and nothing here needs it. The only
-- function the migrations want from it, gen_random_uuid(), has been in core
-- Postgres since 13.

-- Supabase sets these per request; here they are simply empty.
create or replace function auth.jwt() returns jsonb
  language sql stable as $fn$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $fn$;
create or replace function auth.uid() returns uuid
  language sql stable as $fn$ select null::uuid $fn$;
create or replace function auth.role() returns text
  language sql stable as $fn$ select 'authenticated'::text $fn$;

-- Matching Supabase's real column list, not a convenient subset: 0001 sets
-- file_size_limit and allowed_mime_types on the bucket, so a stub missing them
-- fails for a reason that has nothing to do with the migration.
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  owner text,
  owner_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public boolean not null default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets,
  name text,
  owner text,
  created_at timestamptz default now(),
  metadata jsonb
);
alter table storage.objects enable row level security;

insert into storage.buckets (id, name) values ('documents', 'documents')
  on conflict do nothing;

-- Supabase's path helpers, reimplemented to behave the same way: foldername
-- drops the filename and returns the directories, so policies can compare the
-- first folder to a user id.
create or replace function storage.foldername(name text) returns text[]
language plpgsql immutable as $fn$
declare parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1 : array_length(parts, 1) - 1];
end
$fn$;

create or replace function storage.filename(name text) returns text
language plpgsql immutable as $fn$
declare parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[array_length(parts, 1)];
end
$fn$;

create or replace function storage.extension(name text) returns text
language plpgsql immutable as $fn$
declare parts text[];
begin
  parts := string_to_array(storage.filename(name), '.');
  return parts[array_length(parts, 1)];
end
$fn$;
`;

// Roles that exist in every Supabase project. GRANTs against a missing role are
// a hard error, so these have to be present for the migrations to apply at all.
const ROLES = ["anon", "authenticated", "service_role", "postgres", "supabase_admin"];

async function boot() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const role of ROLES) {
    await db.exec(`do $do$ begin
      if not exists (select 1 from pg_roles where rolname = '${role}') then
        create role ${role} nologin;
      end if;
    end $do$;`);
  }
  // `alter publication supabase_realtime add table ...` in 0010 needs one.
  await db.exec(`do $do$ begin
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
      create publication supabase_realtime;
    end if;
  end $do$;`);
  // What a Supabase project hands its API roles before any migration runs:
  // the schema, and every table, sequence and function created after this
  // by default. This is exactly the exposure 0036 takes back on functions,
  // so it has to be here for the grant scenarios to prove anything.
  await db.exec(`
    grant usage on schema public, auth, storage to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  return db;
}

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
let failed = 0;

/**
 * Replaying the whole set on an already-migrated database has exactly one
 * unavoidable casualty, and pretending otherwise would hide the next real one.
 *
 * 0003 renames `is_staff`'s input parameter, and CREATE OR REPLACE cannot
 * rename a parameter — so 0001's version of the function can never be applied
 * again once 0003 has run. 0003 handles this properly for a forward run by
 * dropping the dependent policies, dropping the function, and putting both
 * back. Nobody re-runs 0001 after 0003 in practice; this is only reachable
 * from this harness's own replay sweep.
 */
const EXPECTED_ON_REPLAY = {
  "0001_init.sql": "cannot change name of input parameter",
  // Same knot, one layer out. 0003 drops the policies that depend on is_staff
  // so it can drop the function — but 0011 and 0012 add three more policies
  // that call it, and 0003 cannot know about migrations written after it. On a
  // forward run its list is complete, which is the run that matters.
  "0003_rename_operator.sql": "because other objects depend on it",
};

/** Applies every migration in order and reports the first failure in each. */
async function pass(db, label, replay = false) {
  console.log(`\n— ${label} —`);
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    try {
      await db.exec(sql);
      console.log(`  OK   ${file}`);
    } catch (error) {
      const message = String(error?.message ?? error).split("\n")[0];
      const expected = replay && EXPECTED_ON_REPLAY[file];
      if (expected && message.includes(expected)) {
        console.log(`  --   ${file} — known, see EXPECTED_ON_REPLAY`);
      } else {
        failed++;
        console.log(`  FAIL ${file}\n       ${message}`);
      }
      // Keep going either way: one broken migration shouldn't hide the next,
      // and a later failure caused by this one is still worth seeing.
    }
  }
}

// A raw PGlite error prints the whole bundled WASM chunk. Nobody needs that.
const brief = (error) => String(error?.message ?? error).split("\n")[0];

process.on("uncaughtException", (error) => {
  console.error(`\nFAIL - harness could not start: ${brief(error)}`);
  process.exit(1);
});

const db = await boot().catch((error) => {
  console.error(`\nFAIL - harness could not start: ${brief(error)}`);
  process.exit(1);
});
await pass(db, "applying every migration in order");

// A migration that can't be re-run is a migration you can't safely re-paste
// into the SQL editor after a half-finished attempt — which is exactly how
// these get run.
await pass(db, "applying them a second time (they must be idempotent)", true);

console.log("\n— exercising what the triggers actually do —");

let orderId = null;

/** Runs a scenario and reports the assertion rather than just "it didn't throw". */
async function scenario(name, fn) {
  try {
    const detail = await fn();
    console.log(`  OK   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

const OPERATOR = "11111111-1111-1111-1111-111111111111";

/**
 * Becomes a given user for the statements that follow.
 *
 * `public.clerk_id()` reads `auth.jwt() ->> 'sub'`, and the stub `auth.jwt()`
 * reads the `request.jwt.claims` setting — the same one PostgREST sets per
 * request. So switching identity is one setting, and `is_staff()` follows.
 *
 * RLS itself still isn't enforced (PGlite runs as superuser), so this exercises
 * the trigger and function logic, not the policies.
 */
async function actingAs(userId) {
  // null is Printify's own server: Supabase's service key carries role =
  // service_role and no sub, which is what assert_server() (0032) looks for.
  const claims = userId === null ? JSON.stringify({ role: "service_role" }) : JSON.stringify({ sub: userId });
  await db.query(`select set_config('request.jwt.claims', $1, false);`, [claims]);
}

/**
 * Becomes one of the API roles for real — `set role` — so grants and RLS
 * are enforced for the statements that follow, exactly as PostgREST would
 * have them. `anon` carries no claims; `authenticated` carries the user's.
 * Always paired with asRoot() afterwards, so a failure can't strand the
 * next scenario in the wrong role.
 */
async function asRole(role, userId = null) {
  const claims = role === "anon" ? "" : JSON.stringify({ sub: userId, role: "authenticated" });
  await db.query(`select set_config('request.jwt.claims', $1, false);`, [claims]);
  await db.exec(`set role ${role};`);
}
async function asRoot() {
  await db.exec(`reset role;`);
  await actingAs(null);
}

/** Runs one statement as a role and reports whether the database refused it, and how. */
async function refused(role, userId, sql, params = []) {
  await asRole(role, userId);
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return String(error?.message ?? error).split("\n")[0];
  } finally {
    await asRoot();
  }
}

await scenario("an order gets a token", async () => {
  await db.exec(`
    insert into public.operators (id, name, campus, short_name, is_open)
    values ('${OPERATOR}', 'Block C', 'Main campus', 'Block C', true)
    on conflict (id) do nothing;

    -- 0001 calls the table \`staff\`; 0003 renames its column to operator_id.
    insert into public.staff (user_id, operator_id)
    values ('op_test', '${OPERATOR}')
    on conflict do nothing;
  `);
  await actingAs("student_test");
  // Through the RPC, the way the app does it since 0014: a direct insert is
  // no longer a path a student has.
  const { rows: placed } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([
      { name: "notes.pdf", pages: 10, colour_pages: 2, config: { copies: 1, sides: "single" } },
    ]),
  ]);
  const { rows } = await db.query(`select id, token, total from public.orders where id = $1;`, [
    placed[0].id,
  ]);
  if (!rows[0]?.token) throw new Error("no token was assigned");
  orderId = rows[0].id;
  return `token ${rows[0].token}, priced at ${rows[0].total} by the database`;
});

await scenario("the operator can move it along", async () => {
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'queued' where id = $1;`, [orderId]);
  const { rows } = await db.query(
    `select count(*)::int as n from public.order_events where order_id = $1 and status = 'queued';`,
    [orderId],
  );
  if (rows[0].n < 1) throw new Error("no order_events row was written");
  return `${rows[0].n} timeline event`;
});

// The bug this harness was written too late to catch: the notification trigger
// took its NOT NULL user_id from the student's profile row, and a student who
// has never opened Settings has no profile row. The insert would raise, and
// because it's a trigger, the status change would roll back with it — the
// operator's queue would simply refuse to move.
await scenario("a student with no profile row doesn't jam the queue", async () => {
  const { rows } = await db.query(
    `select channel, status, detail from public.notifications where order_id = $1 order by channel;`,
    [orderId],
  );
  if (rows.length === 0) throw new Error("no notification was queued");
  const summary = rows.map((r) => `${r.channel}:${r.status}`).join(", ");
  return `${summary} — and the status change went through`;
});

// The hole 0012 closed. RLS would have granted the student this row; only the
// trigger stops them rewriting what it costs.
await scenario("a student cannot rewrite their own total", async () => {
  await actingAs("student_test");
  const { rows: before } = await db.query(`select total from public.orders where id = $1;`, [orderId]);
  await db.query(`update public.orders set total = 1 where id = $1;`, [orderId]);
  const { rows } = await db.query(`select total from public.orders where id = $1;`, [orderId]);
  if (Number(rows[0].total) === 1) throw new Error("the student's price change stuck");
  if (rows[0].total !== before[0].total) throw new Error("the total changed at all");
  return `still ${rows[0].total}, not 1`;
});

await scenario("a student cannot fake a refund", async () => {
  await actingAs("student_test");
  await db.query(
    `update public.orders set refunded_at = now(), refund_amount = 30 where id = $1;`,
    [orderId],
  );
  const { rows } = await db.query(
    `select refunded_at, refund_amount from public.orders where id = $1;`,
    [orderId],
  );
  if (rows[0].refunded_at !== null) throw new Error("the student's fake refund stuck");
  return "refunded_at stayed null";
});

await scenario("the operator can record a real one", async () => {
  await actingAs("op_test");
  await db.query(
    `update public.orders
        set refunded_at = now(), refund_amount = 12, refund_note = 'Print came out wrong'
      where id = $1;`,
    [orderId],
  );
  const { rows } = await db.query(`select refund_amount from public.orders where id = $1;`, [
    orderId,
  ]);
  if (rows[0].refund_amount === null) throw new Error("the operator's refund did not save");
  return `${rows[0].refund_amount} recorded`;
});

await scenario("operator_stats_range counts it", async () => {
  await actingAs("op_test");
  const { rows } = await db.query(
    `select * from public.operator_stats_range($1, now() - interval '1 day');`,
    [OPERATOR],
  );
  if (rows.length === 0) throw new Error("staff got no row back");
  const stats = rows[0];
  if (Number(stats.orders) < 1) throw new Error("the order wasn't counted");
  return `${stats.orders} order, ${stats.refunded} refunded`;
});

await scenario("per-file settings survive the round trip", async () => {
  await actingAs("student_test");
  await db.query(
    `insert into public.order_items (order_id, name, pages, colour_pages, price, config)
     values ($1, 'cover.pdf', 1, 1, 8, '{"colour":"full","sides":"single","binding":"none","copies":1}'::jsonb),
            ($1, 'body.pdf', 40, 0, 54, '{"colour":"bw","sides":"double","binding":"staple","copies":1}'::jsonb);`,
    [orderId],
  );
  const { rows } = await db.query(
    `select name, config ->> 'colour' as colour, config ->> 'binding' as binding
       from public.order_items
      where order_id = $1 and name in ('cover.pdf', 'body.pdf') order by name;`,
    [orderId],
  );
  if (rows.length !== 2) throw new Error("items did not save");
  if (rows[0].colour === rows[1].colour) throw new Error("both files got the same colour setting");
  return `${rows[0].name} ${rows[0].colour}, ${rows[1].name} ${rows[1].colour} + ${rows[1].binding}`;
});

// The complaint and the refund are separate acts. This checks the complaint
// half: one open report per order, and the database stamping when it closed
// rather than trusting a client clock.
await scenario("a bad print can be reported once", async () => {
  await actingAs("student_test");
  await db.query(
    `insert into public.order_reports (order_id, user_id, reason, detail)
     values ($1, 'student_test', 'Pages are streaked or faded', 'Page 3 especially');`,
    [orderId],
  );

  let refused = false;
  try {
    await db.query(
      `insert into public.order_reports (order_id, user_id, reason)
       values ($1, 'student_test', 'Wrong pages, or pages missing');`,
      [orderId],
    );
  } catch {
    refused = true;
  }
  if (!refused) throw new Error("a second open report was accepted");
  return "second one refused while the first is open";
});

await scenario("resolving stamps the time and frees the slot", async () => {
  await actingAs("op_test");
  await db.query(
    `update public.order_reports set status = 'resolved', resolution = 'Reprinted'
      where order_id = $1 and status = 'open';`,
    [orderId],
  );
  const { rows } = await db.query(
    `select resolved_at, resolution from public.order_reports where order_id = $1;`,
    [orderId],
  );
  if (!rows[0].resolved_at) throw new Error("resolved_at was not stamped");

  // With the first one closed, a fresh complaint is allowed again.
  await actingAs("student_test");
  await db.query(
    `insert into public.order_reports (order_id, user_id, reason)
     values ($1, 'student_test', 'Not stapled as asked');`,
    [orderId],
  );
  return `${rows[0].resolution}, and a later complaint is accepted`;
});

// ---------------------------------------------------------------
// 0014: the price is decided in the database.
// ---------------------------------------------------------------

/**
 * The rate card as the browser would read it — through PostgREST, where
 * numerics arrive as strings. Building it the same way here means both sides
 * of the comparison start from identical inputs.
 */
async function rateCardFromDb() {
  const { rows } = await db.query(
    `select o.currency, o.bw_per_page::text, o.colour_per_page::text, o.duplex_discount::text,
            o.staple_price::text, o.bulk_threshold, o.bulk_multiplier::text, o.min_order::text, o.paper_gsm,
            o.round_to_rupee,
            ps.fee_percent::text as platform_fee_percent, ps.fee_min::text as platform_fee_min
       from public.operators o, public.platform_settings ps
      where o.id = $1;`,
    [OPERATOR],
  );
  return rateCardOf(rows[0]);
}

await scenario("place_order prices exactly what the browser showed", async () => {
  // Rates with awkward decimals, so a .5 boundary is actually reachable.
  await db.query(
    `update public.operators
        set bw_per_page = 1.35, colour_per_page = 7.75, duplex_discount = 0.08,
            staple_price = 4.50, bulk_threshold = 60, bulk_multiplier = 0.9, min_order = 10
      where id = $1;`,
    [OPERATOR],
  );
  // A fee with a decimal of its own, so the fee's rounding is exercised too.
  await actingAs(null);
  await db.exec(`update public.platform_settings set fee_percent = 3.25, fee_min = 0 where id;`);
  const card = await rateCardFromDb();
  if (card.platformFeePercent !== 3.25) throw new Error("the card didn't pick up the platform fee");

  const colours = ["smart", "bw", "full"];
  const sidesOpts = ["single", "double"];
  const bindings = ["none", "staple"];
  let compared = 0;

  await actingAs("student_test");
  for (const pages of [1, 7, 23, 48, 61, 120]) {
    for (const colour of colours) {
      for (const sides of sidesOpts) {
        for (const binding of bindings) {
          for (const copies of [1, 3]) {
            const colourPages = Math.min(pages, Math.floor(pages / 3));
            const lines = [
              { pages, colourPages, config: { colour, sides, binding, copies } },
              // A second, different file so the bulk slab and the per-file
              // binding both get exercised in the same order.
              { pages: 5, colourPages: 1, config: { colour: "bw", sides: "single", binding: "none", copies: 1 } },
            ];
            const expected = quoteOrder(lines, card).total;

            const items = lines.map((l, i) => ({
              name: `f${i}.pdf`,
              pages: l.pages,
              colour_pages: l.colourPages,
              config: l.config,
            }));

            // The rate limit in place_order is 20/hour; clear the slate so the
            // grid can run, since this is arithmetic being tested, not the cap.
            await db.query(`delete from public.orders where user_id = 'student_test' and token <> 'A01';`);

            const q = quoteOrder(lines, card);
            const { rows } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
              OPERATOR,
              JSON.stringify(items),
            ]);
            const { rows: got } = await db.query(
              `select o.total, o.platform_fee, o.rate_card,
                      (select array_agg(i.price order by i.ordinal) from public.order_items i where i.order_id = o.id) as prices
                 from public.orders o where o.id = $1;`,
              [rows[0].id],
            );
            const actual = Number(got[0].total);
            if (actual !== expected) {
              throw new Error(
                `${pages}p ${colour}/${sides}/${binding} x${copies}: SQL ${actual} vs TS ${expected}`,
              );
            }
            // The fee itself, and the snapshot that lets the bill be rebuilt later.
            if (Number(got[0].platform_fee) !== q.platformFee) {
              throw new Error(
                `${pages}p ${colour}/${sides}/${binding} x${copies}: fee SQL ${got[0].platform_fee} vs TS ${q.platformFee}`,
              );
            }
            if (String(got[0].rate_card.platform_fee_percent) !== "3.25") {
              throw new Error("the platform fee percent wasn't snapshotted onto the order");
            }
            // Per line, to the paisa — the bill shown must be the bill stored.
            const sqlPrices = (got[0].prices ?? []).map(Number);
            q.lines.forEach((l, i) => {
              if (sqlPrices[i] !== l.price) {
                throw new Error(
                  `${pages}p ${colour}/${sides}/${binding} x${copies} line ${i}: SQL ${sqlPrices[i]} vs TS ${l.price}`,
                );
              }
            });
            if (!got[0].rate_card || String(got[0].rate_card.bw_per_page) !== "1.35") {
              throw new Error("the rate card wasn't snapshotted onto the order");
            }
            compared++;
          }
        }
      }
    }
  }
  return `${compared} jobs — every total and every line price identical to the paisa, rate card snapshotted`;
});

await scenario("a file that isn't yours can't go on your order", async () => {
  await actingAs("student_test");
  await db.query(
    `insert into public.documents (id, user_id, name, kind, storage_path, size_bytes, pages)
     values ('22222222-2222-2222-2222-222222222222', 'someone_else', 'theirs.pdf', 'pdf',
             'someone_else/theirs.pdf', 1000, 3);`,
  );
  let refused = false;
  try {
    await db.query(`select public.place_order($1, $2::jsonb);`, [
      OPERATOR,
      JSON.stringify([
        { name: "theirs.pdf", pages: 3, colour_pages: 0, document_id: "22222222-2222-2222-2222-222222222222" },
      ]),
    ]);
  } catch (error) {
    refused = /not yours/.test(String(error?.message ?? error));
  }
  if (!refused) throw new Error("someone else's document was accepted on the order");
  return "refused";
});

await scenario("a document row can't point at someone else's file", async () => {
  await actingAs("student_test");
  let refused = false;
  try {
    await db.query(
      `insert into public.documents (user_id, name, kind, storage_path, size_bytes, pages)
       values ('student_test', 'sneaky.pdf', 'pdf', 'someone_else/theirs.pdf', 10, 1);`,
    );
  } catch (error) {
    const message = String(error?.message ?? error);
    refused = /documents_path_owned/.test(message);
    if (!refused) throw new Error(`refused, but not by the path check: ${brief(error)}`);
  }
  if (!refused) throw new Error("a row pointing at another user's path was accepted");
  return "documents_path_owned held";
});

await scenario("a push endpoint on a private address is refused", async () => {
  let refused = false;
  try {
    await db.query(
      `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
       values ('student_test', 'https://10.0.0.5/internal', 'k', 'a');`,
    );
  } catch (error) {
    refused = /push_endpoint_sane/.test(String(error?.message ?? error));
  }
  if (!refused) throw new Error("a private-network endpoint was stored");
  await db.query(
    `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
     values ('student_test', 'https://fcm.googleapis.com/fcm/send/abc', 'k', 'a');`,
  );
  return "10.0.0.5 refused, fcm.googleapis.com accepted";
});

await scenario("the order rate limit holds", async () => {
  await actingAs("student_test");
  await db.query(`delete from public.orders where user_id = 'student_test' and token <> 'A01';`);
  const items = JSON.stringify([{ name: "a.pdf", pages: 1, colour_pages: 0 }]);
  // One already exists from the first scenario (token A01).
  for (let i = 0; i < 19; i++) {
    await db.query(`select public.place_order($1, $2::jsonb);`, [OPERATOR, items]);
  }
  let refused = false;
  try {
    await db.query(`select public.place_order($1, $2::jsonb);`, [OPERATOR, items]);
  } catch (error) {
    refused = /lot of orders/.test(String(error?.message ?? error));
  }
  if (!refused) throw new Error("the 21st order in an hour went through");
  return "20 allowed, the 21st refused";
});

// ---------------------------------------------------------------
// 0015: desk tools.
// ---------------------------------------------------------------
await scenario("a message to the student queues a push", async () => {
  await actingAs("op_test");
  await db.query(
    `insert into public.order_messages (order_id, sender, body)
     values ($1, 'op_test', 'Page 3 is blank — print it anyway?');`,
    [orderId],
  );
  const { rows } = await db.query(
    `select channel, status, body from public.notifications
      where order_id = $1 and body like '%blank%' order by channel;`,
    [orderId],
  );
  if (rows.length !== 2) throw new Error(`expected push + whatsapp rows, got ${rows.length}`);
  if (!rows[0].body.includes("A01")) throw new Error("the message doesn't name the order");
  return `${rows.map((r) => `${r.channel}:${r.status}`).join(", ")}`;
});

await scenario("stock is a ledger", async () => {
  await actingAs("op_test");
  await db.query(`update public.operators set paper_stock = 100, toner_pages = 1000 where id = $1;`, [OPERATOR]);
  await db.query(`select public.adjust_stock($1, 500, 0, 'New ream');`, [OPERATOR]);
  const { rows: after } = await db.query(`select paper_stock from public.operators where id = $1;`, [OPERATOR]);
  if (Number(after[0].paper_stock) !== 600) throw new Error(`paper is ${after[0].paper_stock}, not 600`);

  // Collecting a job draws it down and writes its own ledger row.
  await db.query(`update public.orders set status = 'collected' where id = $1;`, [orderId]);
  const { rows: log } = await db.query(
    `select paper_delta, actor, order_id from public.stock_log where operator_id = $1 order by id;`,
    [OPERATOR],
  );
  const manual = log.find((r) => r.actor === "op_test" && Number(r.paper_delta) === 500);
  const auto = log.find((r) => r.actor === null && Number(r.paper_delta) < 0);
  if (!manual) throw new Error("the manual adjustment wasn't logged");
  if (!auto) throw new Error("the collection wasn't logged by the trigger");
  return `+500 by op_test, ${auto.paper_delta} by the system on collection`;
});

await scenario("staff can be added by email and the last one can't leave", async () => {
  await actingAs("op_test");
  await db.query(
    `insert into public.profiles (id, email, name) values ('colleague', 'Pat@Example.com', 'Pat')
     on conflict (id) do nothing;`,
  );
  const { rows } = await db.query(`select public.add_staff($1, '  pat@example.com ') as id;`, [OPERATOR]);
  if (rows[0].id !== "colleague") throw new Error("email lookup failed");

  let refused = false;
  try {
    await db.query(`select public.add_staff($1, 'nobody@example.com');`, [OPERATOR]);
  } catch (error) {
    refused = /sign in once/.test(String(error?.message ?? error));
  }
  if (!refused) throw new Error("an unknown email was accepted");

  await db.query(`select public.remove_staff($1, 'colleague');`, [OPERATOR]);
  let last = false;
  try {
    await db.query(`select public.remove_staff($1, 'op_test');`, [OPERATOR]);
  } catch (error) {
    last = /nobody running/.test(String(error?.message ?? error));
  }
  if (!last) throw new Error("the last staff member was removed");
  return "added by email (case-insensitive), unknown refused, last one kept";
});

await scenario("closing the desk snapshots the day and shuts it", async () => {
  await actingAs("op_test");
  await db.query(`update public.operators set is_open = true where id = $1;`, [OPERATOR]);
  const { rows } = await db.query(`select * from public.close_desk($1, 250, 'Drawer counted twice');`, [OPERATOR]);
  const out = rows[0];
  if (out.counted_cash === null) throw new Error("counted cash not stored");
  const { rows: op } = await db.query(`select is_open from public.operators where id = $1;`, [OPERATOR]);
  if (op[0].is_open) throw new Error("the desk stayed open");
  // A second close the same day replaces the count rather than adding a row.
  await db.query(`select public.close_desk($1, 260, null);`, [OPERATOR]);
  const { rows: n } = await db.query(`select count(*)::int as n from public.desk_closeouts where operator_id = $1;`, [OPERATOR]);
  if (n[0].n !== 1) throw new Error(`expected one closeout row, got ${n[0].n}`);
  return `expected ${out.expected_cash} cash, counted ${out.counted_cash}, desk closed, one row per day`;
});

// ---------------------------------------------------------------
// 0016: a hundred students at one desk, and the handover code.
// ---------------------------------------------------------------
await scenario("a hundred orders at one desk get a hundred distinct tokens", async () => {
  // A fresh desk so the day's sequence starts clean, and a hundred different
  // students so the per-user rate limit doesn't get in the way of the point.
  await db.query(
    `insert into public.operators (id, name, campus, short_name, is_open, is_listed)
     values ('33333333-3333-3333-3333-333333333333', 'Rush desk', 'Main campus', 'Rush', true, true)
     on conflict (id) do nothing;`,
  );
  const items = JSON.stringify([{ name: "notes.pdf", pages: 3, colour_pages: 0 }]);
  const ids = [];
  for (let i = 0; i < 100; i++) {
    await actingAs(`rush_${i}`);
    const { rows } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
      "33333333-3333-3333-3333-333333333333",
      items,
    ]);
    ids.push(rows[0].id);
  }
  const { rows } = await db.query(
    `select token, handover_code from public.orders
      where operator_id = '33333333-3333-3333-3333-333333333333' order by created_at, token;`,
  );
  const tokens = rows.map((r) => r.token);
  const codes = rows.map((r) => r.handover_code);
  if (new Set(tokens).size !== 100) throw new Error(`only ${new Set(tokens).size} distinct tokens`);
  if (new Set(codes).size !== 100) throw new Error(`only ${new Set(codes).size} distinct codes`);
  if (codes.some((c) => !/^[0-9A-F]{8}$/.test(c))) throw new Error("a handover code is malformed");
  if (!tokens.includes("A99") || !tokens.includes("B01")) throw new Error("the sequence didn't roll from A99 to B01");
  return `${tokens[0]} … ${tokens[98]}, ${tokens[99]}; every code 8 hex chars, all distinct`;
});

await scenario("a duplicate token is refused by the index, not just by luck", async () => {
  // Bypass the trigger by supplying a token that already exists today.
  let refused = false;
  try {
    await db.query(
      `insert into public.orders (user_id, operator_id, token, pages, colour_pages, total, config)
       values ('rush_0', '33333333-3333-3333-3333-333333333333', 'A01', 1, 0, 5, '{}'::jsonb);`,
    );
  } catch (error) {
    refused = /orders_token_unique_per_day/.test(String(error?.message ?? error));
  }
  if (!refused) throw new Error("a second A01 on the same desk and day was accepted");
  return "second A01 today refused";
});

await scenario("a student cannot change their handover code", async () => {
  await actingAs("rush_5");
  const { rows: before } = await db.query(
    `select id, handover_code from public.orders where user_id = 'rush_5';`,
  );
  await db.query(`update public.orders set handover_code = 'AAAAAAAA' where id = $1;`, [before[0].id]);
  const { rows: after } = await db.query(`select handover_code from public.orders where id = $1;`, [
    before[0].id,
  ]);
  if (after[0].handover_code !== before[0].handover_code) throw new Error("the code was changed");
  return "pinned by the guard";
});

// ---------------------------------------------------------------
// 0018: a paired desk and a PIN per shift.
// ---------------------------------------------------------------
let deskToken = null;

await scenario("a device can be paired once and the token is never stored", async () => {
  await actingAs("op_test");
  const { rows } = await db.query(`select public.pair_device($1, 'Counter tablet') as token;`, [OPERATOR]);
  deskToken = rows[0].token;
  if (!/^[0-9a-f]{64}$/.test(deskToken)) throw new Error(`token is ${deskToken}`);
  const { rows: stored } = await db.query(`select token_hash from public.desk_devices where operator_id = $1;`, [OPERATOR]);
  if (stored.some((r) => r.token_hash === deskToken)) throw new Error("the raw token was stored");
  return "64 hex chars returned, only the hash kept";
});

await scenario("a signed-out device can list the desk's staff by token", async () => {
  await actingAs(null);
  const { rows } = await db.query(`select * from public.desk_staff($1);`, [deskToken]);
  if (rows.length === 0) throw new Error("no staff returned for a live token");
  if (!rows.some((r) => r.user_id === "op_test")) throw new Error("op_test missing");
  if (rows.some((r) => r.has_pin)) throw new Error("a PIN is reported before any was set");
  const { rows: bad } = await db.query(`select * from public.desk_staff('not-a-token');`);
  if (bad.length !== 0) throw new Error("a wrong token listed staff");
  return `${rows.length} on the desk, no PINs yet; a wrong token gets nothing`;
});

await scenario("a PIN must be four to six digits and not obvious", async () => {
  await actingAs("op_test");
  for (const weak of ["12", "1234", "abcd", "0000"]) {
    let refused = false;
    try {
      await db.query(`select public.set_my_pin($1, $2);`, [OPERATOR, weak]);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error(`'${weak}' was accepted`);
  }
  await db.query(`select public.set_my_pin($1, '4827');`, [OPERATOR]);
  const { rows } = await db.query(`select pin_hash from public.staff_pins where user_id = 'op_test';`);
  if (rows[0].pin_hash.includes("4827")) throw new Error("the PIN is stored in the clear");
  return "12, 1234, abcd, 0000 refused; 4827 set and hashed";
});

await scenario("the right PIN on a paired device names the person", async () => {
  await actingAs(null);
  const { rows } = await db.query(`select * from public.desk_verify_pin($1, 'op_test', '4827');`, [deskToken]);
  if (!rows[0].ok || rows[0].who !== "op_test") throw new Error(`got ${JSON.stringify(rows[0])}`);
  return "op_test";
});

await scenario("five wrong PINs lock that person for five minutes", async () => {
  await actingAs(null);
  let wrongs = 0;
  for (let i = 0; i < 5; i++) {
    const { rows } = await db.query(`select * from public.desk_verify_pin($1, 'op_test', '0001');`, [deskToken]);
    if (!rows[0].ok && /Wrong PIN/.test(rows[0].message)) wrongs++;
  }
  if (wrongs !== 5) throw new Error(`expected 5 wrong-PIN refusals, got ${wrongs}`);
  const { rows: lockedRow } = await db.query(`select * from public.desk_verify_pin($1, 'op_test', '4827');`, [deskToken]);
  if (lockedRow[0].ok || !/Locked for/.test(lockedRow[0].message)) throw new Error("the right PIN was accepted while locked");
  // A lock on one person is not a lock on the desk.
  await db.query(`insert into public.profiles (id, name) values ('other_staff', 'Rahul') on conflict do nothing;`);
  await db.query(`insert into public.staff (user_id, operator_id) values ('other_staff', $1) on conflict do nothing;`, [OPERATOR]);
  await actingAs("other_staff");
  await db.query(`select public.set_my_pin($1, '7391');`, [OPERATOR]);
  await actingAs(null);
  const { rows } = await db.query(`select * from public.desk_verify_pin($1, 'other_staff', '7391');`, [deskToken]);
  if (!rows[0].ok) throw new Error("the other person was locked out too");
  // Resetting the PIN clears the lock.
  await actingAs("op_test");
  await db.query(`select public.set_my_pin($1, '5150');`, [OPERATOR]);
  await actingAs(null);
  const { rows: fresh } = await db.query(`select * from public.desk_verify_pin($1, 'op_test', '5150');`, [deskToken]);
  if (!fresh[0].ok) throw new Error("a new PIN didn't clear the lock");
  return "locked after 5, other staff unaffected, a new PIN unlocks";
});

await scenario("a revoked device is a dead device", async () => {
  await actingAs("op_test");
  const { rows } = await db.query(`select id from public.desk_devices where operator_id = $1 and revoked_at is null;`, [OPERATOR]);
  await db.query(`select public.revoke_device($1);`, [rows[0].id]);
  await actingAs(null);
  const { rows: staff } = await db.query(`select * from public.desk_staff($1);`, [deskToken]);
  if (staff.length !== 0) throw new Error("a revoked token still lists staff");
  const { rows: dead } = await db.query(`select * from public.desk_verify_pin($1, 'op_test', '5150');`, [deskToken]);
  if (dead[0].ok || !/not paired/.test(dead[0].message)) throw new Error("a revoked device could still sign someone in");
  return "lists nothing, signs nobody in";
});

/* ---------- 0019: join codes ---------- */

let joinCode = null;
let newDesk = null;

await scenario("an admin creates a desk and gets an owner code", async () => {
  await actingAs(null);
  await db.exec(`insert into public.admins (user_id) values ('admin_test') on conflict do nothing;`);

  // Not an admin: refused.
  await actingAs("student_test");
  let refused = false;
  try {
    await db.query(`select public.create_operator('Sharma Stationery, CEC', 'CEC');`);
  } catch (error) {
    refused = /Only an admin/.test(String(error?.message ?? error));
  }
  if (!refused) throw new Error("a student created a desk");

  await actingAs("admin_test");
  const { rows } = await db.query(`select public.create_operator('Sharma Stationery, CEC', 'CEC') as id;`);
  newDesk = rows[0].id;
  const { rows: desk } = await db.query(`select short_name, is_open, is_listed from public.operators where id = $1;`, [newDesk]);
  if (desk[0].short_name !== "Sharma Stationery" || desk[0].is_open || !desk[0].is_listed) {
    throw new Error(`desk row is wrong: ${JSON.stringify(desk[0])}`);
  }

  // The admin isn't staff of it, and can still make its first code.
  const { rows: inv } = await db.query(`select * from public.create_invite($1, 'Owner');`, [newDesk]);
  joinCode = inv[0].code;
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(joinCode)) throw new Error(`code has the wrong shape: ${joinCode}`);
  const hours = (new Date(inv[0].expires_at) - Date.now()) / 3600000;
  if (hours < 23.9 || hours > 24.1) throw new Error(`expiry is ${hours.toFixed(2)} h, not 24`);

  const { rows: list } = await db.query(`select * from public.admin_desks();`);
  const mine = list.find((d) => d.id === newDesk);
  if (!mine || Number(mine.staff_count) !== 0 || Number(mine.open_invites) !== 1) {
    throw new Error(`admin_desks reports ${JSON.stringify(mine)}`);
  }
  // The admin can read the live code again; a second one replaces it.
  if (mine.owner_code !== joinCode) throw new Error(`admin_desks shows owner_code ${mine.owner_code}`);
  const { rows: again } = await db.query(`select * from public.create_invite($1, 'Owner');`, [newDesk]);
  const { rows: old } = await db.query(`select revoked_at from public.staff_invites where code = $1;`, [joinCode]);
  if (!old[0].revoked_at) throw new Error("a second owner code left the first alive");
  const { rows: list2 } = await db.query(`select owner_code, open_invites from public.admin_desks() where id = $1;`, [newDesk]);
  if (list2[0].owner_code !== again[0].code || Number(list2[0].open_invites) !== 1) {
    throw new Error(`after a new code: ${JSON.stringify(list2[0])}`);
  }
  joinCode = again[0].code;
  return `${joinCode.slice(0, 4)}-${joinCode.slice(4)}, 24 h, readable on the desk's row; a new one cancelled the first`;
});

await scenario("a join code adds whoever claims it, exactly once", async () => {
  // Typed sloppily — lower case, a dash, a space — on purpose.
  const typed = `${joinCode.slice(0, 4).toLowerCase()}-${joinCode.slice(4)} `;
  await actingAs("owner_test");
  const { rows } = await db.query(`select * from public.claim_invite($1);`, [typed]);
  if (!rows[0]?.ok || rows[0].operator_id !== newDesk || rows[0].operator_name !== "Sharma Stationery, CEC") {
    throw new Error(`claim returned ${JSON.stringify(rows[0])}`);
  }
  const { rows: staff } = await db.query(
    `select 1 from public.staff where user_id = 'owner_test' and operator_id = $1;`,
    [newDesk],
  );
  if (staff.length !== 1) throw new Error("claiming didn't add them to staff");
  const { rows: used } = await db.query(`select claimed_by from public.staff_invites where code = $1;`, [joinCode]);
  if (used[0].claimed_by !== "owner_test") throw new Error("the code doesn't record who used it");

  await actingAs("someone_else");
  const { rows: again } = await db.query(`select * from public.claim_invite($1);`, [joinCode]);
  if (again[0].ok || !/already been used/.test(again[0].message)) throw new Error("a used code worked twice");

  // With someone on the desk, the admin's view no longer carries a code.
  await actingAs("admin_test");
  const { rows: staffed } = await db.query(`select owner_code from public.admin_desks() where id = $1;`, [newDesk]);
  if (staffed[0].owner_code !== null) throw new Error("owner_code still shown for a staffed desk");

  // The owner, now staff, makes the next code — and from here the admin is
  // shut out of this desk's staff entirely.
  await actingAs("owner_test");
  const { rows: next } = await db.query(`select * from public.create_invite($1, 'Priya');`, [newDesk]);
  if (!next[0]?.code) throw new Error("staff can't make a code");
  joinCode = next[0].code;

  await actingAs("admin_test");
  let adminOut = false;
  try {
    await db.query(`select * from public.create_invite($1, 'Admin sneaking in');`, [newDesk]);
  } catch (error) {
    adminOut = /Only staff/.test(String(error?.message ?? error));
  }
  if (!adminOut) throw new Error("the admin could still make a code for a staffed desk");
  const { rows: row } = await db.query(`select id from public.staff_invites where code = $1;`, [joinCode]);
  let adminRevoke = false;
  try {
    await db.query(`select public.revoke_invite($1);`, [row[0].id]);
  } catch (error) {
    adminRevoke = /No open code/.test(String(error?.message ?? error));
  }
  if (!adminRevoke) throw new Error("the admin could revoke a staffed desk's code");
  return "typed as xk7p-2q4m, joined, recorded; second use refused; owner makes codes now, admin can't";
});

await scenario("admin is granted by hand only", async () => {
  const { rows: fn } = await db.query(
    `select count(*)::int as n from pg_proc where proname = 'claim_first_admin';`,
  );
  if (fn[0].n !== 0) throw new Error("claim_first_admin still exists");
  // No client write path: the only policy on admins is a read.
  const { rows: pol } = await db.query(
    `select cmd from pg_policies where schemaname = 'public' and tablename = 'admins';`,
  );
  const cmds = pol.map((r) => r.cmd).sort();
  if (cmds.join(",") !== "SELECT") throw new Error(`admins policies: ${cmds.join(", ") || "none"}`);
  // And no function in the schema writes it, other than nothing.
  const { rows: writers } = await db.query(
    `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and prosrc ~* 'insert into public\\.admins';`,
  );
  if (writers.length) throw new Error(`functions writing admins: ${writers.map((r) => r.proname).join(", ")}`);
  return "no claim function, only a read policy, no function inserts into admins";
});

await scenario("an expired or cancelled code is a dead code", async () => {
  await actingAs(null);
  await db.query(`update public.staff_invites set expires_at = now() - interval '1 minute' where code = $1;`, [joinCode]);
  await actingAs("priya_test");
  const { rows: late } = await db.query(`select * from public.claim_invite($1);`, [joinCode]);
  if (late[0].ok || !/expired/.test(late[0].message)) throw new Error("an expired code was accepted");

  await actingAs("owner_test");
  const { rows: fresh } = await db.query(`select * from public.create_invite($1, 'Priya');`, [newDesk]);
  const { rows: row } = await db.query(`select id from public.staff_invites where code = $1;`, [fresh[0].code]);
  await db.query(`select public.revoke_invite($1);`, [row[0].id]);
  await actingAs("priya_test");
  const { rows: dead } = await db.query(`select * from public.claim_invite($1);`, [fresh[0].code]);
  if (dead[0].ok || !/cancelled/.test(dead[0].message)) throw new Error("a revoked code was accepted");

  // A student can't make one for a desk they don't run.
  await actingAs("student_test");
  let outsider = false;
  try {
    await db.query(`select * from public.create_invite($1, null);`, [newDesk]);
  } catch (error) {
    outsider = /Only staff/.test(String(error?.message ?? error));
  }
  if (!outsider) throw new Error("a non-staff user made a code");
  return "expired refused, revoked refused, outsider can't mint";
});

await scenario("twenty bad guesses in an hour and you wait", async () => {
  await actingAs("guesser_test");
  let lastMessage = "";
  for (let i = 0; i < 21; i++) {
    const { rows } = await db.query(`select * from public.claim_invite('ZZZZZZZZ');`);
    lastMessage = rows[0].message;
    if (i < 20 && !/isn't one we know/.test(lastMessage)) throw new Error(`guess ${i + 1} said: ${lastMessage}`);
  }
  if (!/Too many tries/.test(lastMessage)) throw new Error(`21st guess said: ${lastMessage}`);
  // Someone else is unaffected.
  await actingAs("priya_test");
  const { rows: other } = await db.query(`select * from public.claim_invite('ZZZZZZZZ');`);
  if (!/isn't one we know/.test(other[0].message)) throw new Error(`another user saw: ${other[0].message}`);
  return "21st refused for an hour; another user still gets a plain 'not known'";
});

await scenario("applying: a form, a review, a code only the applicant can use", async () => {
  // Someone with a desk account, on no desk, applies.
  await actingAs("applicant_test");
  const { rows: app } = await db.query(
    `select public.apply_for_desk('Verma Xerox, Block D', 'Main campus', 'Ground floor', '9876543210', 'HP M428', null) as id;`,
  );
  let twice = false;
  try {
    await db.query(`select public.apply_for_desk('Again', 'Main campus', null, '9876543210', null, null);`);
  } catch (error) {
    twice = /already have an application/.test(String(error?.message ?? error));
  }
  if (!twice) throw new Error("a second pending application was accepted");
  const { rows: mine } = await db.query(`select * from public.my_application();`);
  if (mine[0]?.status !== "pending" || mine[0].code_live !== false) throw new Error(`my_application: ${JSON.stringify(mine[0])}`);

  // Only the admin approves; approving makes the desk and a code for the applicant.
  let outsider = false;
  try {
    await db.query(`select * from public.approve_application($1, null);`, [app[0].id]);
  } catch (error) {
    outsider = /Only the admin/.test(String(error?.message ?? error));
  }
  if (!outsider) throw new Error("a non-admin approved an application");
  await actingAs("admin_test");
  const { rows: ok } = await db.query(`select * from public.approve_application($1, 'Welcome');`, [app[0].id]);
  if (!ok[0]?.operator_id || !/^[A-HJ-NP-Z2-9]{8}$/.test(ok[0].code)) throw new Error(`approve returned ${JSON.stringify(ok[0])}`);
  const { rows: desk } = await db.query(`select name, short_name, is_open from public.operators where id = $1;`, [ok[0].operator_id]);
  if (desk[0].name !== "Verma Xerox, Block D" || desk[0].short_name !== "Verma Xerox" || desk[0].is_open) {
    throw new Error(`desk row: ${JSON.stringify(desk[0])}`);
  }
  const { rows: listed } = await db.query(`select code, code_claimed, applicant_name from public.admin_applications('approved');`);
  const row = listed.find((r) => r.code === ok[0].code);
  if (!row || row.code_claimed) throw new Error("admin_applications doesn't show the live code");

  // The code is the applicant's: someone else is refused, they get in.
  await actingAs("someone_else");
  const { rows: wrong } = await db.query(`select * from public.claim_invite($1);`, [ok[0].code]);
  if (wrong[0].ok || !/different account/.test(wrong[0].message)) throw new Error(`another account: ${JSON.stringify(wrong[0])}`);
  await actingAs("applicant_test");
  const { rows: seen } = await db.query(`select code_live from public.my_application();`);
  if (seen[0].code_live !== true) throw new Error("the applicant isn't told the code is live");
  const { rows: joined } = await db.query(`select * from public.claim_invite($1);`, [ok[0].code]);
  if (!joined[0].ok || joined[0].operator_id !== ok[0].operator_id) throw new Error(`applicant claim: ${JSON.stringify(joined[0])}`);
  const { rows: staff } = await db.query(`select 1 from public.staff where user_id = 'applicant_test' and operator_id = $1;`, [ok[0].operator_id]);
  if (staff.length !== 1) throw new Error("the applicant isn't on the desk");
  // Already running a desk: can't apply again.
  let running = false;
  try {
    await db.query(`select public.apply_for_desk('Another', 'Campus', null, '1', null, null);`);
  } catch (error) {
    running = /already run a desk/.test(String(error?.message ?? error));
  }
  if (!running) throw new Error("someone on a desk could apply again");

  // Reject needs a reason; withdraw is the applicant's.
  await actingAs("applicant_two");
  const { rows: app2 } = await db.query(
    `select public.apply_for_desk('Sharma Prints', 'North campus', null, '9999999999', null, 'evenings only') as id;`,
  );
  await actingAs("admin_test");
  let noReason = false;
  try {
    await db.query(`select public.reject_application($1, '  ');`, [app2[0].id]);
  } catch (error) {
    noReason = /Say why/.test(String(error?.message ?? error));
  }
  if (!noReason) throw new Error("a rejection without a reason went through");
  await db.query(`select public.reject_application($1, 'No printer listed');`, [app2[0].id]);
  await actingAs("applicant_two");
  const { rows: rejected } = await db.query(`select status, review_note from public.my_application();`);
  if (rejected[0].status !== "rejected" || rejected[0].review_note !== "No printer listed") throw new Error(`rejected: ${JSON.stringify(rejected[0])}`);
  const { rows: app3 } = await db.query(`select public.apply_for_desk('Sharma Prints', 'North campus', null, '9999999999', 'Canon', null) as id;`);
  await db.query(`select public.withdraw_application($1);`, [app3[0].id]);
  const { rows: withdrawn } = await db.query(`select status from public.my_application();`);
  if (withdrawn[0].status !== "withdrawn") throw new Error("withdraw didn't take");
  return "applied once; admin approved → desk + a code for that account only; wrong account refused; applicant joined; rejected with a reason; withdrawn";
});

await scenario("the platform fee is a line on the bill, to the paisa, on top of the minimum", async () => {
  await actingAs(null);
  await db.exec(`
    update public.platform_settings set fee_percent = 3, fee_min = 0 where id;
    update public.operators set bw_per_page = 1.50, colour_per_page = 8, duplex_discount = 0.08,
           staple_price = 5, bulk_threshold = 100, bulk_multiplier = 0.92, min_order = 10
     where id = '${OPERATOR}';
  `);
  const card = await rateCardFromDb();
  await actingAs("student_fee");
  // 7 pages B&W single-sided at ₹1.50 = ₹10.50; 3% = 0.315 → ₹0.32; total ₹10.82.
  const lines = [{ pages: 7, colourPages: 0, config: { colour: "bw", sides: "single", binding: "none", copies: 1 } }];
  const q = quoteOrder(lines, card);
  const { rows } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "n.pdf", pages: 7, colour_pages: 0, config: lines[0].config }]),
  ]);
  const { rows: got } = await db.query(`select total, platform_fee, rate_card from public.orders where id = $1;`, [rows[0].id]);
  if (Number(got[0].platform_fee) !== 0.32 || Number(got[0].total) !== 10.82) {
    throw new Error(`SQL fee ${got[0].platform_fee} total ${got[0].total}`);
  }
  if (q.platformFee !== 0.32 || q.total !== 10.82) throw new Error(`TS fee ${q.platformFee} total ${q.total}`);

  // Under the minimum: the fee is on the lifted amount, not the lines.
  const small = [{ pages: 2, colourPages: 0, config: { colour: "bw", sides: "single", binding: "none", copies: 1 } }];
  const qs = quoteOrder(small, card); // lines ₹3 → min ₹10 → fee ₹0.30 → ₹10.30
  const { rows: r2 } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "s.pdf", pages: 2, colour_pages: 0, config: small[0].config }]),
  ]);
  const { rows: g2 } = await db.query(`select total, platform_fee from public.orders where id = $1;`, [r2[0].id]);
  if (Number(g2[0].platform_fee) !== 0.3 || Number(g2[0].total) !== 10.3 || qs.total !== 10.3) {
    throw new Error(`under the minimum: SQL ${g2[0].platform_fee}/${g2[0].total}, TS ${qs.platformFee}/${qs.total}`);
  }
  return "₹10.50 + 3% = ₹10.82; ₹3 lifted to ₹10 + 3% = ₹10.30, both sides";
});

await scenario("a minimum fee floors small orders; changing the rate touches only new orders", async () => {
  await actingAs(null);
  await db.exec(`update public.platform_settings set fee_percent = 3, fee_min = 1 where id;`);
  await actingAs("student_fee");
  const cfg = { colour: "bw", sides: "single", binding: "none", copies: 1 };
  const { rows } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "s.pdf", pages: 7, colour_pages: 0, config: cfg }]),
  ]);
  const { rows: got } = await db.query(`select total, platform_fee from public.orders where id = $1;`, [rows[0].id]);
  if (Number(got[0].platform_fee) !== 1 || Number(got[0].total) !== 11.5) {
    throw new Error(`floor: fee ${got[0].platform_fee}, total ${got[0].total}`);
  }
  const card = await rateCardFromDb();
  const q = quoteOrder([{ pages: 7, colourPages: 0, config: cfg }], card);
  if (q.platformFee !== 1 || q.total !== 11.5) throw new Error(`TS floor: ${q.platformFee}/${q.total}`);

  // Only the admin changes the rate, and an order placed before keeps its own.
  await actingAs("student_fee");
  let refused = false;
  try {
    await db.query(`select public.set_platform_fee(10, 0, null, null);`);
  } catch (error) {
    refused = /Only the admin/.test(String(error?.message ?? error));
  }
  if (!refused) throw new Error("a student changed the platform fee");
  await actingAs("admin_test");
  await db.query(`select public.set_platform_fee(5, 0, 'printify@upi', 'Printify');`);
  const { rows: same } = await db.query(`select platform_fee from public.orders where id = $1;`, [rows[0].id]);
  if (Number(same[0].platform_fee) !== 1) throw new Error("an existing order's fee moved with the setting");
  await actingAs("student_fee");
  const { rows: r2 } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "n.pdf", pages: 20, colour_pages: 0, config: cfg }]),
  ]);
  const { rows: g2 } = await db.query(`select platform_fee, rate_card ->> 'platform_fee_percent' as pct from public.orders where id = $1;`, [r2[0].id]);
  // 20 × ₹1.50 = ₹30 → 5% = ₹1.50
  if (Number(g2[0].platform_fee) !== 1.5 || Number(g2[0].pct) !== 5) throw new Error(`new order: ${JSON.stringify(g2[0])}`);
  await actingAs(null);
  await db.exec(`update public.platform_settings set fee_percent = 3, fee_min = 0 where id;`);
  return "₹0.32 floored to ₹1; student refused; 5% applies to the next order only";
});

await scenario("a student cannot rewrite the platform fee", async () => {
  await actingAs("student_fee");
  const { rows } = await db.query(`select id, platform_fee from public.orders where user_id = 'student_fee' order by created_at limit 1;`);
  await db.query(`update public.orders set platform_fee = 0 where id = $1;`, [rows[0].id]);
  const { rows: after } = await db.query(`select platform_fee from public.orders where id = $1;`, [rows[0].id]);
  if (Number(after[0].platform_fee) !== Number(rows[0].platform_fee)) throw new Error("the guard let it through");
  return `still ${after[0].platform_fee}`;
});

await scenario("the desk's ledger: owed on collected orders, minus what was settled", async () => {
  // Three of student_fee's orders: collect two (one fully refunded), leave one placed.
  await actingAs(null);
  const { rows: mine } = await db.query(
    `select id, total, platform_fee from public.orders where user_id = 'student_fee' order by created_at;`,
  );
  if (mine.length < 3) throw new Error(`expected 3 orders, found ${mine.length}`);
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'queued' where id in ($1, $2);`, [mine[0].id, mine[1].id]);
  await db.query(`update public.orders set status = 'ready' where id in ($1, $2);`, [mine[0].id, mine[1].id]);
  await db.query(`update public.orders set status = 'collected' where id in ($1, $2);`, [mine[0].id, mine[1].id]);
  // The second one is refunded in full: no fee owed on it.
  await db.query(
    `update public.orders set refunded_at = now(), refund_amount = total, refund_note = 'misprint' where id = $1;`,
    [mine[1].id],
  );
  const owed = Number(mine[0].platform_fee);

  const { rows: win } = await db.query(`select * from public.fee_window($1, now() - interval '1 hour', now());`, [OPERATOR]);
  const { rows: bal } = await db.query(`select * from public.fee_balance($1);`, [OPERATOR]);
  // op_test has other collected orders from earlier scenarios; isolate by checking the deltas.
  const winFee = Number(win[0].fee);
  const { rows: check } = await db.query(
    `select coalesce(sum(platform_fee), 0)::numeric as f, count(*)::int as n from public.orders
      where operator_id = $1 and status = 'collected' and collected_at >= now() - interval '1 hour'
        and (refund_amount is null or refund_amount < total);`,
    [OPERATOR],
  );
  if (winFee !== Number(check[0].f) || win[0].orders !== check[0].n) throw new Error(`fee_window ${JSON.stringify(win[0])} vs ${JSON.stringify(check[0])}`);
  if (winFee < owed) throw new Error(`window fee ${winFee} doesn't include the collected order's ${owed}`);
  const { rows: refundedIncluded } = await db.query(
    `select count(*)::int as n from public.orders where id = $1 and refund_amount >= total;`,
    [mine[1].id],
  );
  if (refundedIncluded[0].n !== 1) throw new Error("the refunded order wasn't marked fully refunded");

  // Settle part of it as the admin; a student can't.
  await actingAs("student_fee");
  let refused = false;
  try {
    await db.query(`select public.record_settlement($1, 5, 'sneaky');`, [OPERATOR]);
  } catch (error) {
    refused = /Only the admin/.test(String(error?.message ?? error));
  }
  if (!refused) throw new Error("a student recorded a settlement");
  await actingAs("admin_test");
  await db.query(`select public.record_settlement($1, 0.25, 'September, part');`, [OPERATOR]);
  const { rows: bal2 } = await db.query(`select * from public.fee_balance($1);`, [OPERATOR]);
  // Compared in paise: the SQL numerics are exact, JS subtraction isn't.
  const inPaise = (v) => Math.round(Number(v) * 100);
  if (inPaise(bal2[0].settled) !== inPaise(bal[0].settled) + 25) throw new Error("the settlement didn't count");
  if (inPaise(bal2[0].outstanding) !== inPaise(bal2[0].accrued) - inPaise(bal2[0].settled)) throw new Error("outstanding ≠ accrued − settled");

  // The admin sees every desk; the window figures match the desk's own.
  const { rows: desks } = await db.query(`select * from public.admin_fee_desks(now() - interval '1 hour', now());`);
  const row = desks.find((d) => d.operator_id === OPERATOR);
  if (!row || Number(row.fee) !== winFee || Number(row.outstanding) !== Number(bal2[0].outstanding)) {
    throw new Error(`admin_fee_desks: ${JSON.stringify(row)}`);
  }
  // Takings carry the fee too.
  await actingAs("op_test");
  const { rows: stats } = await db.query(`select platform_fee from public.operator_stats_range($1, now() - interval '1 hour', now());`, [OPERATOR]);
  if (Number(stats[0].platform_fee) !== winFee) throw new Error(`operator_stats_range fee ${stats[0].platform_fee} vs ${winFee}`);
  return `owed ${winFee} in the window; refunded order excluded; settled 0.25; outstanding ${bal2[0].outstanding}; admin sees the same`;
});

/* ---------- 0025: the fee has a due date ---------- */

await scenario("an overdue fee locks the desk closed until it's settled", async () => {
  // One of the collected orders is from last month, so its fee is due now.
  // As staff: the write guard pins collected_at for anyone else, superuser
  // or not — triggers don't care who you are.
  await actingAs("op_test");
  const { rows: old } = await db.query(
    `update public.orders set collected_at = date_trunc('month', now()) - interval '3 days'
      where operator_id = $1 and status = 'collected'
        and (refund_amount is null or refund_amount < total)
        and platform_fee > 0
      returning platform_fee;`,
    [OPERATOR],
  );
  if (old.length === 0) throw new Error("no collected order with a fee to backdate");
  const backdated = old.reduce((n, r) => n + Number(r.platform_fee), 0);
  await actingAs(null);
  await db.query(`update public.operators set is_open = false where id = $1;`, [OPERATOR]);

  // With no grace at all, it's overdue the moment the month turns.
  await actingAs("admin_test");
  await db.query(`select public.set_platform_fee(3, 0, 'printify@upi', 'Printify', 0);`);
  await actingAs("op_test");
  const { rows: st } = await db.query(`select * from public.fee_status($1);`, [OPERATOR]);
  if (!st[0]?.overdue || Number(st[0].due) <= 0) {
    throw new Error(`fee_status: ${JSON.stringify(st[0])} (backdated ${backdated.toFixed(2)} across ${old.length} orders)`);
  }
  let refused = "";
  try {
    await db.query(`update public.operators set is_open = true where id = $1;`, [OPERATOR]);
  } catch (error) {
    refused = String(error?.message ?? error);
  }
  if (!/overdue/.test(refused)) throw new Error(`opening wasn't refused: ${refused || "no error"}`);
  // Closing is always allowed, whatever is owed.
  await db.query(`update public.operators set is_open = false where id = $1;`, [OPERATOR]);

  // Inside the grace period it's due but not overdue, and the desk opens.
  await actingAs("admin_test");
  await db.query(`select public.set_platform_fee(3, 0, 'printify@upi', 'Printify', 90);`);
  await actingAs("op_test");
  const { rows: st2 } = await db.query(`select * from public.fee_status($1);`, [OPERATOR]);
  if (st2[0].overdue || Number(st2[0].due) !== Number(st[0].due)) throw new Error(`within grace: ${JSON.stringify(st2[0])}`);
  await db.query(`update public.operators set is_open = true where id = $1;`, [OPERATOR]);
  await db.query(`update public.operators set is_open = false where id = $1;`, [OPERATOR]);

  // Settling what's due unlocks it even with no grace.
  await actingAs("admin_test");
  await db.query(`select public.set_platform_fee(3, 0, 'printify@upi', 'Printify', 0);`);
  await db.query(`select public.record_settlement($1, $2, 'August, in full');`, [OPERATOR, Number(st[0].due)]);
  await actingAs("op_test");
  const { rows: st3 } = await db.query(`select * from public.fee_status($1);`, [OPERATOR]);
  if (st3[0].overdue || Number(st3[0].due) !== 0) throw new Error(`after settling: ${JSON.stringify(st3[0])}`);
  await db.query(`update public.operators set is_open = true where id = $1;`, [OPERATOR]);
  const { rows: open } = await db.query(`select is_open from public.operators where id = $1;`, [OPERATOR]);
  if (!open[0].is_open) throw new Error("the desk didn't open after settling");
  await actingAs("admin_test");
  await db.query(`select public.set_platform_fee(3, 0, null, null, 15);`);
  return `due ${st[0].due} for ${String(st[0].due_month).slice(0, 7)}; refused at 0 days grace, allowed at 90, open again once settled`;
});

/* ---------- 0021: the desk hears about new orders ---------- */

await scenario("a new order pushes to staff with a desk device, and only them", async () => {
  await actingAs(null);
  // op_test has a desk device; a second staff member has only a student one.
  await db.exec(`
    insert into public.staff (user_id, operator_id) values ('op_two', '${OPERATOR}') on conflict do nothing;
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, desk)
    values ('op_test', 'https://fcm.googleapis.com/fcm/send/desk-1', 'k', 'a', true),
           ('op_two',  'https://fcm.googleapis.com/fcm/send/phone-2', 'k', 'a', false)
    on conflict (endpoint) do nothing;
  `);
  // A fresh student: student_test has hit the hourly order cap by now.
  await actingAs("student_push");
  const { rows: placed } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "essay.pdf", pages: 7, colour_pages: 2, config: { copies: 1, sides: "single" } }]),
  ]);
  await actingAs(null);
  const { rows } = await db.query(
    `select user_id, body, status, audience from public.notifications
      where order_id = $1 and audience = 'desk' order by user_id;`,
    [placed[0].id],
  );
  if (rows.length !== 1 || rows[0].user_id !== "op_test") {
    throw new Error(`desk rows went to: ${rows.map((r) => r.user_id).join(", ") || "nobody"}`);
  }
  if (rows[0].status !== "queued") throw new Error(`status ${rows[0].status}`);
  const { rows: ord } = await db.query(`select token, total from public.orders where id = $1;`, [placed[0].id]);
  const expected = `New order ${ord[0].token} — 7 pages, 2 colour, ₹${Number(ord[0].total) % 1 === 0 ? Number(ord[0].total) : Number(ord[0].total).toFixed(2)}`;
  if (rows[0].body !== expected) throw new Error(`body "${rows[0].body}" ≠ "${expected}"`);
  // The student's own rows are untouched by the new column.
  const { rows: student } = await db.query(
    `select count(*)::int as n from public.notifications where order_id = $1 and audience = 'student';`,
    [placed[0].id],
  );
  if (student[0].n !== 0) throw new Error("a placed order queued a student notification, which it never did");
  return `"${rows[0].body}" → op_test only; op_two's phone stays quiet`;
});

/* ---------- 0026: the admin can shut a desk ---------- */

await scenario("the admin shuts a desk; its staff finish the queue and nothing else", async () => {
  // A desk of its own, so the others above keep their state.
  await actingAs("admin_test");
  const { rows: made } = await db.query(`select public.create_operator('Pop-up Print, Gate 2', 'CEC') as id;`);
  const desk = made[0].id;
  const { rows: code } = await db.query(`select code from public.create_invite($1, 'Owner');`, [desk]);
  await actingAs("shut_owner");
  const { rows: claimed } = await db.query(`select ok from public.claim_invite($1);`, [code[0].code]);
  if (!claimed[0].ok) throw new Error("the owner couldn't claim the desk");
  await db.query(`update public.operators set is_open = true where id = $1;`, [desk]);
  await db.query(`select public.create_invite($1, 'Second person');`, [desk]);

  // A student with a paid job in the queue before the shutter comes down.
  await actingAs("student_shut");
  const { rows: placed } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    desk,
    JSON.stringify([{ name: "cv.pdf", pages: 2, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
  ]);

  // Not the owner's verb, and not a student's.
  for (const who of ["shut_owner", "student_shut"]) {
    await actingAs(who);
    let refused = "";
    try {
      await db.query(`select public.shut_operator($1, 'trying');`, [desk]);
    } catch (error) {
      refused = String(error?.message ?? error);
    }
    if (!/Only the admin/.test(refused)) throw new Error(`${who} could shut the desk: ${refused || "no error"}`);
  }

  await actingAs("admin_test");
  let noReason = "";
  try {
    await db.query(`select public.shut_operator($1, '  ');`, [desk]);
  } catch (error) {
    noReason = String(error?.message ?? error);
  }
  if (!/Say why/.test(noReason)) throw new Error(`a blank reason went through: ${noReason || "no error"}`);
  const { rows: shut } = await db.query(`select public.shut_operator($1, 'Charged students twice, twice.') as live;`, [desk]);
  if (Number(shut[0].live) !== 1) throw new Error(`live orders reported as ${shut[0].live}, expected 1`);

  const { rows: row } = await db.query(
    `select is_open, is_listed, shut_at, shut_reason, shut_by, status_note from public.operators where id = $1;`,
    [desk],
  );
  if (row[0].is_open || row[0].is_listed || !row[0].shut_at || row[0].shut_by !== "admin_test") {
    throw new Error(`after shutting: ${JSON.stringify(row[0])}`);
  }
  const { rows: invites } = await db.query(
    `select count(*)::int as n from public.staff_invites where operator_id = $1 and revoked_at is null and claimed_at is null;`,
    [desk],
  );
  if (invites[0].n !== 0) throw new Error(`${invites[0].n} join code(s) still open`);
  const { rows: seen } = await db.query(
    `select shut_reason, live_orders, staff_count from public.admin_desks() where id = $1;`,
    [desk],
  );
  if (seen[0].shut_reason !== "Charged students twice, twice." || Number(seen[0].live_orders) !== 1 || Number(seen[0].staff_count) !== 1) {
    throw new Error(`admin_desks shows ${JSON.stringify(seen[0])}`);
  }

  // The desk's own hands are tied: no reopening, no relisting, no new codes,
  // no new staff — each refused by a trigger, so a direct update is no way round.
  await actingAs("shut_owner");
  const attempts = [
    ["open", `update public.operators set is_open = true where id = $1;`, /closed by Printify: Charged/],
    ["relist", `update public.operators set is_listed = true where id = $1;`, /cannot be listed/],
    ["unmark", `update public.operators set shut_at = null where id = $1;`, /Only the admin shuts/],
    ["code", `select public.create_invite($1, 'Sneaky');`, /closed by Printify/],
    ["staff", `insert into public.staff (user_id, operator_id) values ('shut_friend', $1);`, /closed by Printify/],
  ];
  for (const [what, sql, expect] of attempts) {
    let refused = "";
    try {
      await db.query(sql, [desk]);
    } catch (error) {
      refused = String(error?.message ?? error);
    }
    if (!expect.test(refused)) throw new Error(`${what} wasn't refused: ${refused || "no error"}`);
  }
  // A student can't start anything new there.
  await actingAs("student_shut");
  let noOrder = "";
  try {
    await db.query(`select public.place_order($1, $2::jsonb);`, [
      desk,
      JSON.stringify([{ name: "again.pdf", pages: 1, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
    ]);
  } catch (error) {
    noOrder = String(error?.message ?? error);
  }
  if (!/not taking orders/.test(noOrder)) throw new Error(`a new order got in: ${noOrder || "no error"}`);

  // But the job already paid for is still the desk's to finish.
  await actingAs("shut_owner");
  for (const to of ["queued", "printing", "ready", "collected"]) {
    await db.query(`update public.orders set status = $2 where id = $1;`, [placed[0].id, to]);
  }
  const { rows: done } = await db.query(`select status from public.orders where id = $1;`, [placed[0].id]);
  if (done[0].status !== "collected") throw new Error(`the live order ended as ${done[0].status}`);

  // Restored: listed and closed, and the owner opens it as before.
  await actingAs("shut_owner");
  let notYours = "";
  try {
    await db.query(`select public.restore_operator($1);`, [desk]);
  } catch (error) {
    notYours = String(error?.message ?? error);
  }
  if (!/Only the admin/.test(notYours)) throw new Error(`the owner restored their own desk: ${notYours || "no error"}`);
  await actingAs("admin_test");
  await db.query(`select public.restore_operator($1);`, [desk]);
  await actingAs("shut_owner");
  await db.query(`update public.operators set is_open = true where id = $1;`, [desk]);
  const { rows: back } = await db.query(`select is_open, is_listed, shut_at from public.operators where id = $1;`, [desk]);
  if (!back[0].is_open || !back[0].is_listed || back[0].shut_at !== null) throw new Error(`after restoring: ${JSON.stringify(back[0])}`);
  await db.query(`select public.create_invite($1, 'Allowed again');`, [desk]);
  return "shut with 1 live order: unlisted, closed, codes revoked; staff refused at every door, finished the job; restored, open again";
});

/* ---------- 0027: a UPI id says what kind it is ---------- */

await scenario("a desk's UPI id is personal until it says merchant; the fee id the same", async () => {
  await actingAs("op_test");
  const { rows: before } = await db.query(`select upi_kind, upi_mc from public.operators where id = $1;`, [OPERATOR]);
  if (before[0].upi_kind !== "personal" || before[0].upi_mc !== null) throw new Error(`default: ${JSON.stringify(before[0])}`);
  await db.query(`update public.operators set upi_kind = 'merchant', upi_mc = '5111' where id = $1;`, [OPERATOR]);
  for (const [what, sql] of [
    ["kind", `update public.operators set upi_kind = 'business' where id = $1;`],
    ["code", `update public.operators set upi_mc = '51' where id = $1;`],
  ]) {
    let refused = false;
    try {
      await db.query(sql, [OPERATOR]);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error(`a bad ${what} was accepted`);
  }
  await db.query(`update public.operators set upi_kind = 'personal', upi_mc = null where id = $1;`, [OPERATOR]);

  await actingAs("admin_test");
  await db.query(`select public.set_platform_fee(3, 0, 'printify@upi', 'Printify', 15, 'merchant');`);
  const { rows: ps } = await db.query(`select payee_kind from public.platform_settings where id;`);
  if (ps[0].payee_kind !== "merchant") throw new Error(`payee_kind ${ps[0].payee_kind}`);
  // The five-argument call from before 0027 still works, and leaves the kind alone.
  await db.query(`select public.set_platform_fee(3, 0, 'printify@upi', 'Printify', 15);`);
  const { rows: ps2 } = await db.query(`select payee_kind from public.platform_settings where id;`);
  if (ps2[0].payee_kind !== "merchant") throw new Error(`five-arg call changed the kind to ${ps2[0].payee_kind}`);
  let bad = false;
  try {
    await db.query(`select public.set_platform_fee(3, 0, 'printify@upi', 'Printify', 15, 'crypto');`);
  } catch {
    bad = true;
  }
  if (!bad) throw new Error("an unknown payee kind was accepted");
  await db.query(`select public.set_platform_fee(3, 0, null, null, 15, 'personal');`);
  return "desk: personal by default, merchant + 4-digit code accepted, junk refused; fee id: set to merchant, a five-arg call leaves it, junk refused";
});

/* ---------- 0028: the rupee, and the amount as a fact ---------- */

await scenario("a desk that rounds is priced to the rupee, in SQL and in the browser alike", async () => {
  await actingAs(null);
  await db.query(`update public.operators set round_to_rupee = true where id = $1;`, [OPERATOR]);
  await db.exec(`update public.platform_settings set fee_percent = 3.25, fee_min = 0 where id;`);
  const card = await rateCardFromDb();
  if (!card.roundToRupee) throw new Error("the card didn't pick up round_to_rupee");
  let compared = 0;
  let rounded = 0;
  await actingAs("student_round");
  for (const pages of [1, 7, 23, 48, 61]) {
    for (const colour of ["smart", "bw", "full"]) {
      for (const copies of [1, 3]) {
        const lines = [
          { pages, colourPages: Math.floor(pages / 3), config: { colour, sides: "double", binding: "staple", copies } },
          { pages: 5, colourPages: 1, config: { colour: "bw", sides: "single", binding: "none", copies: 1 } },
        ];
        const q = quoteOrder(lines, card);
        if (!Number.isInteger(q.total)) throw new Error(`TS total ${q.total} is not whole`);
        await db.query(`delete from public.orders where user_id = 'student_round';`);
        const { rows } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
          OPERATOR,
          JSON.stringify(lines.map((l, i) => ({ name: `r${i}.pdf`, pages: l.pages, colour_pages: l.colourPages, config: l.config }))),
        ]);
        const { rows: got } = await db.query(
          `select total, platform_fee, rounding, full_colour_total, rate_card from public.orders where id = $1;`,
          [rows[0].id],
        );
        const label = `${pages}p ${colour} x${copies}`;
        if (Number(got[0].total) !== q.total) throw new Error(`${label}: SQL ${got[0].total} vs TS ${q.total}`);
        if (Number(got[0].rounding) !== q.rounding) throw new Error(`${label}: rounding SQL ${got[0].rounding} vs TS ${q.rounding}`);
        if (Number(got[0].platform_fee) !== q.platformFee) throw new Error(`${label}: fee changed by rounding`);
        if (Number(got[0].full_colour_total) !== q.fullColourTotal) throw new Error(`${label}: full-colour SQL ${got[0].full_colour_total} vs TS ${q.fullColourTotal}`);
        if (got[0].rate_card.round_to_rupee !== true) throw new Error("round_to_rupee wasn't snapshotted");
        if (q.rounding > 0) rounded++;
        compared++;
      }
    }
  }
  await actingAs(null);
  await db.query(`update public.operators set round_to_rupee = false where id = $1;`, [OPERATOR]);
  await db.exec(`update public.platform_settings set fee_percent = 3, fee_min = 0 where id;`);
  if (rounded === 0) throw new Error("no job in the grid needed rounding — the grid isn't testing it");
  return `${compared} jobs whole to the rupee, ${rounded} of them lifted; fee untouched, rounding on the row and in the snapshot`;
});

await scenario("the amount received is the desk's fact; the amount sent is the student's claim", async () => {
  await actingAs("student_amount");
  const { rows: placed } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "a.pdf", pages: 9, colour_pages: 1, config: { copies: 1, sides: "single" } }]),
  ]);
  const id = placed[0].id;
  const { rows: o } = await db.query(`select total from public.orders where id = $1;`, [id]);
  const total = Number(o[0].total);

  // The student says what their app showed — allowed, and kept as a claim.
  await db.query(
    `update public.orders set payment_method = 'upi', payment_claimed_at = now(), payment_claimed_amount = $2 where id = $1;`,
    [id, total - 0.5],
  );
  // But not the desk's facts.
  await db.query(`update public.orders set payment_received = $2, rounding = 0.5, shortfall_cleared_at = now() where id = $1;`, [id, total]);
  const { rows: pinned } = await db.query(
    `select payment_claimed_amount, payment_received, rounding, shortfall_cleared_at from public.orders where id = $1;`,
    [id],
  );
  if (Number(pinned[0].payment_claimed_amount) !== total - 0.5) throw new Error("the student's claim wasn't kept");
  if (pinned[0].payment_received !== null || Number(pinned[0].rounding) !== 0 || pinned[0].shortfall_cleared_at !== null) {
    throw new Error(`a student wrote the desk's facts: ${JSON.stringify(pinned[0])}`);
  }
  let big = false;
  try {
    await db.query(`update public.orders set payment_claimed_amount = 999999 where id = $1;`, [id]);
  } catch {
    big = true;
  }
  if (!big) throw new Error("an absurd claimed amount was accepted");

  // The desk confirms with what actually arrived: short by fifty paise.
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'queued', payment_received = $2 where id = $1;`, [id, total - 0.5]);
  const { rows: taken } = await db.query(
    `select payment_taken_at, payment_received, payment_claimed_amount from public.orders where id = $1;`,
    [id],
  );
  if (!taken[0].payment_taken_at || Number(taken[0].payment_received) !== total - 0.5) throw new Error(`confirm: ${JSON.stringify(taken[0])}`);

  // Confirmed: the student's claim is frozen, like the reference.
  await actingAs("student_amount");
  await db.query(`update public.orders set payment_claimed_amount = $2 where id = $1;`, [id, total]);
  const { rows: frozen } = await db.query(`select payment_claimed_amount from public.orders where id = $1;`, [id]);
  if (Number(frozen[0].payment_claimed_amount) !== total - 0.5) throw new Error("the claim changed after confirmation");

  // The desk collects the rest at the counter and says so.
  await actingAs("op_test");
  await db.query(`update public.orders set shortfall_cleared_at = now() where id = $1;`, [id]);
  const { rows: cleared } = await db.query(`select shortfall_cleared_at from public.orders where id = $1;`, [id]);
  if (!cleared[0].shortfall_cleared_at) throw new Error("the shortfall wasn't cleared");

  // A tap with no number means the money was right.
  await actingAs("student_amount");
  const { rows: second } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "b.pdf", pages: 2, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
  ]);
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'queued' where id = $1;`, [second[0].id]);
  const { rows: exact } = await db.query(`select total, payment_received from public.orders where id = $1;`, [second[0].id]);
  if (Number(exact[0].payment_received) !== Number(exact[0].total)) throw new Error("a bare confirm didn't record the bill as received");
  return `claimed ${(total - 0.5).toFixed(2)} of ${total.toFixed(2)} kept, desk's columns refused; confirmed short, claim frozen, shortfall cleared; bare confirm = bill`;
});

/* ---------- 0029: the capsule's queue position without knowing the id ---------- */

await scenario("queue_status_mine finds the caller's newest live order and nobody else's", async () => {
  await actingAs("student_amount");
  const { rows: mine } = await db.query(`select * from public.queue_status_mine();`);
  if (mine.length !== 1) throw new Error(`expected one row, got ${mine.length}`);
  const { rows: check } = await db.query(
    `select o.id, q.place, q.pages_ahead, q.wait_minutes
       from public.orders o cross join lateral public.queue_status(o.id) q
      where o.id = $1;`,
    [mine[0].order_id],
  );
  if (check[0].place !== mine[0].place || check[0].wait_minutes !== mine[0].wait_minutes) {
    throw new Error(`mine ${JSON.stringify(mine[0])} vs queue_status ${JSON.stringify(check[0])}`);
  }
  const { rows: owner } = await db.query(`select user_id, status from public.orders where id = $1;`, [mine[0].order_id]);
  if (owner[0].user_id !== "student_amount") throw new Error("someone else's order came back");
  if (!["placed", "queued", "printing", "finishing", "ready"].includes(owner[0].status)) throw new Error(`not live: ${owner[0].status}`);
  await actingAs("nobody_here");
  const { rows: none } = await db.query(`select * from public.queue_status_mine();`);
  if (none.length !== 0) throw new Error("a stranger got a row");
  return `order ${String(mine[0].order_id).slice(0, 8)} place ${mine[0].place}, ${mine[0].wait_minutes} min; a stranger gets nothing`;
});

/* ---------- 0030: the shelf and the board ---------- */

await scenario("ready jobs take the lowest free shelf slot; the slot frees on collection; full shelf means no slot", async () => {
  await actingAs(null);
  await db.query(`update public.operators set shelf_rows = 1, shelf_cols = 2 where id = $1;`, [OPERATOR]);
  const place = async (who, name) => {
    await actingAs(who);
    const { rows } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
      OPERATOR,
      JSON.stringify([{ name, pages: 2, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
    ]);
    return rows[0].id;
  };
  const ids = [await place("shelf_a", "a.pdf"), await place("shelf_b", "b.pdf"), await place("shelf_c", "c.pdf")];
  await actingAs("op_test");
  for (const id of ids) {
    await db.query(`update public.orders set status = 'queued' where id = $1;`, [id]);
    await db.query(`update public.orders set status = 'printing' where id = $1;`, [id]);
    await db.query(`update public.orders set status = 'ready' where id = $1;`, [id]);
  }
  const slots = async () => {
    const { rows } = await db.query(`select id, status, shelf_slot from public.orders where id = any($1::uuid[]) order by created_at;`, [ids]);
    return rows.map((r) => r.shelf_slot);
  };
  let got = await slots();
  if (JSON.stringify(got) !== JSON.stringify(["A1", "A2", null])) throw new Error(`first fill: ${JSON.stringify(got)}`);

  // The student can't touch the slot.
  await actingAs("shelf_a");
  await db.query(`update public.orders set shelf_slot = 'A2' where id = $1;`, [ids[0]]);
  got = await slots();
  if (got[0] !== "A1") throw new Error(`a student moved their packet: ${got[0]}`);

  // A1 collected: the third job still has none (assignment is on the
  // transition), but the desk can hand it the freed slot by hand.
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'collected' where id = $1;`, [ids[0]]);
  await db.query(`update public.orders set shelf_slot = 'A1' where id = $1;`, [ids[2]]);
  got = await slots();
  if (JSON.stringify(got) !== JSON.stringify(["A1", "A2", "A1"])) throw new Error(`after collection: ${JSON.stringify(got)}`);
  const { rows: inUse } = await db.query(
    `select shelf_slot from public.orders where operator_id = $1 and status = 'ready' and shelf_slot is not null order by shelf_slot;`,
    [OPERATOR],
  );
  if (inUse.map((r) => r.shelf_slot).join(",") !== "A1,A2") throw new Error(`in use: ${inUse.map((r) => r.shelf_slot)}`);

  // A fourth job now finds nothing free; a fifth after a collection finds A2.
  const d = await place("shelf_d", "d.pdf");
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'queued' where id = $1;`, [d]);
  await db.query(`update public.orders set status = 'ready' where id = $1;`, [d]);
  const { rows: dRow } = await db.query(`select shelf_slot from public.orders where id = $1;`, [d]);
  if (dRow[0].shelf_slot !== null) throw new Error(`a full shelf handed out ${dRow[0].shelf_slot}`);
  await db.query(`update public.orders set status = 'collected' where id = $1;`, [ids[1]]);
  const e = await place("shelf_e", "e.pdf");
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'queued' where id = $1;`, [e]);
  await db.query(`update public.orders set status = 'ready' where id = $1;`, [e]);
  const { rows: eRow } = await db.query(`select shelf_slot from public.orders where id = $1;`, [e]);
  if (eRow[0].shelf_slot !== "A2") throw new Error(`freed slot not reused: ${eRow[0].shelf_slot}`);

  // Junk slots are refused; a desk with no shelf assigns nothing.
  let bad = false;
  try {
    await db.query(`update public.orders set shelf_slot = 'Z99' where id = $1;`, [e]);
  } catch {
    bad = true;
  }
  if (!bad) throw new Error("a slot off the shelf was accepted");
  await actingAs(null);
  await db.query(`update public.operators set shelf_rows = 0 where id = $1;`, [OPERATOR]);
  const f = await place("shelf_f", "f.pdf");
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'queued' where id = $1;`, [f]);
  await db.query(`update public.orders set status = 'ready' where id = $1;`, [f]);
  const { rows: fRow } = await db.query(`select shelf_slot from public.orders where id = $1;`, [f]);
  if (fRow[0].shelf_slot !== null) throw new Error("a desk with no shelf assigned a slot");

  // The board: tokens and slots for this desk, no names, nothing from a shut desk.
  await actingAs(null);
  const { rows: board } = await db.query(`select * from public.board($1);`, [OPERATOR]);
  const cols = Object.keys(board[0] ?? {});
  if (cols.some((c) => /user|name|file/i.test(c))) throw new Error(`the board leaks: ${cols}`);
  const readyOnBoard = board.filter((r) => r.status === "ready").map((r) => r.shelf_slot).filter(Boolean).sort();
  if (readyOnBoard.join(",") !== "A1,A2") throw new Error(`board slots: ${readyOnBoard}`);
  if (board[0].status !== "ready") throw new Error("ready jobs don't lead the board");
  await actingAs("admin_test");
  await db.query(`select public.shut_operator($1, 'board check');`, [OPERATOR]);
  await actingAs(null);
  const { rows: shut } = await db.query(`select * from public.board($1);`, [OPERATOR]);
  await actingAs("admin_test");
  await db.query(`select public.restore_operator($1);`, [OPERATOR]);
  await actingAs(null);
  if (shut.length !== 0) throw new Error("a shut desk still shows a board");
  await db.query(`delete from public.orders where user_id like 'shelf_%';`);
  return `A1, A2, none; student can't move; freed A1 reassigned by hand, A2 reused on the next ready; Z99 refused; no shelf → no slot; board leads with ready, no names, dark when shut`;
});

/* ---------- 0032: paid through Printify ---------- */

await scenario("a gateway payment is the server's write: marks paid and queued once, retains the fee, and nobody else can touch it", async () => {
  await actingAs(null);
  await db.exec(`update public.platform_settings set fee_percent = 3, fee_min = 0 where id;`);
  await actingAs("student_gw");
  const { rows: placed } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "g.pdf", pages: 20, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
  ]);
  const id = placed[0].id;
  const { rows: o } = await db.query(`select total, platform_fee from public.orders where id = $1;`, [id]);
  const total = Number(o[0].total);
  const fee = Number(o[0].platform_fee);
  if (fee <= 0) throw new Error("no fee on the order; the scenario needs one");

  // A browser — student, staff — gets nothing from the gateway functions.
  for (const who of ["student_gw", "op_test"]) {
    await actingAs(who);
    let refused = false;
    try {
      await db.query(`select public.gateway_begin($1, 'PFTEST1');`, [id]);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error(`${who} could call gateway_begin`);
  }
  // And can't write the columns by hand.
  await actingAs("student_gw");
  await db.query(`update public.orders set gateway_order_id = 'PFHACK', gateway_paid_at = now(), fee_settled_at = now() where id = $1;`, [id]);
  const { rows: pinned } = await db.query(`select gateway_order_id, gateway_paid_at, fee_settled_at from public.orders where id = $1;`, [id]);
  if (pinned[0].gateway_order_id !== null || pinned[0].gateway_paid_at !== null || pinned[0].fee_settled_at !== null) {
    throw new Error(`a student wrote gateway columns: ${JSON.stringify(pinned[0])}`);
  }

  // The server (service role — the harness is superuser, which passes the grant).
  await actingAs(null);
  await db.query(`select public.gateway_begin($1, 'PFTEST1');`, [id]);
  let bad = false;
  try {
    await db.query(`select public.gateway_paid($1, 'cf_1', $2, 'upi', now());`, [id, total - 1]);
  } catch {
    bad = true;
  }
  if (!bad) throw new Error("a short gateway payment was accepted");
  const { rows: first } = await db.query(`select public.gateway_paid($1, 'cf_1', $2, 'upi', now()) as fresh;`, [id, total]);
  if (first[0].fresh !== true) throw new Error("first webhook wasn't fresh");
  const { rows: again } = await db.query(`select public.gateway_paid($1, 'cf_1', $2, 'upi', now()) as fresh;`, [id, total]);
  if (again[0].fresh !== false) throw new Error("a retried webhook was treated as a second payment");
  const { rows: paid } = await db.query(
    `select status, payment_method, payment_taken_at, payment_received, gateway_payment_id, fee_settled_at, note from public.orders where id = $1;`,
    [id],
  );
  const r = paid[0];
  if (r.status !== "queued" || r.payment_method !== "gateway" || !r.payment_taken_at || Number(r.payment_received) !== total
      || r.gateway_payment_id !== "cf_1" || !r.fee_settled_at) {
    throw new Error(`paid row: ${JSON.stringify(r)}`);
  }
  if (!/Paid online/.test(r.note ?? "")) throw new Error(`note: ${r.note}`);

  // The desk finishes it; the fee is not in what it owes, and is "retained" for the admin.
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'printing' where id = $1;`, [id]);
  await db.query(`update public.orders set status = 'ready' where id = $1;`, [id]);
  await db.query(`update public.orders set status = 'collected' where id = $1;`, [id]);
  const { rows: win } = await db.query(`select * from public.fee_window($1, now() - interval '1 hour');`, [OPERATOR]);
  if (Number(win[0].retained) < fee) throw new Error(`retained ${win[0].retained} < fee ${fee}`);
  const { rows: bal0 } = await db.query(`select * from public.fee_balance($1);`, [OPERATOR]);
  const { rows: stats } = await db.query(`select online_total, upi_total from public.operator_stats_range($1, now() - interval '1 hour');`, [OPERATOR]);
  if (Number(stats[0].online_total) < total) throw new Error(`online_total ${stats[0].online_total} < ${total}`);
  // Sanity: the same order paid by UPI would have added its fee to the balance.
  await actingAs("student_gw");
  const { rows: placed2 } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "h.pdf", pages: 20, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
  ]);
  await actingAs("op_test");
  for (const st of ["queued", "printing", "ready", "collected"]) {
    await db.query(`update public.orders set status = $2 where id = $1;`, [placed2[0].id, st]);
  }
  const { rows: bal1 } = await db.query(`select * from public.fee_balance($1);`, [OPERATOR]);
  if (Math.round((Number(bal1[0].accrued) - Number(bal0[0].accrued)) * 100) !== Math.round(fee * 100)) {
    throw new Error(`a UPI order added ${Number(bal1[0].accrued) - Number(bal0[0].accrued)} to the balance, expected ${fee}`);
  }
  await actingAs("admin_test");
  const { rows: desks } = await db.query(`select retained, gateway_status from public.admin_fee_desks(now() - interval '1 hour') where operator_id = $1;`, [OPERATOR]);
  if (Number(desks[0].retained) < fee || desks[0].gateway_status !== "off") throw new Error(`admin row: ${JSON.stringify(desks[0])}`);

  // A refund through the gateway is written by the server; a student can't.
  await actingAs("student_gw");
  let noRefund = false;
  try {
    await db.query(`select public.gateway_refunded($1, 'rf_1', 5, 'test');`, [id]);
  } catch {
    noRefund = true;
  }
  if (!noRefund) throw new Error("a student could call gateway_refunded");
  await actingAs(null);
  await db.query(`select public.gateway_refunded($1, 'rf_1', 5, 'Print came out wrong');`, [id]);
  const { rows: rf } = await db.query(`select refunded_at, refund_amount, gateway_refund_id from public.orders where id = $1;`, [id]);
  if (!rf[0].refunded_at || Number(rf[0].refund_amount) !== 5 || rf[0].gateway_refund_id !== "rf_1") throw new Error(`refund: ${JSON.stringify(rf[0])}`);
  await db.query(`delete from public.orders where user_id = 'student_gw';`);
  return `paid ${total} (fee ${fee}) → queued once, retry a no-op, short refused; fee retained, not owed; online_total counted; refund by the server only`;
});

/* ---------- 0033: the fee, order by order ---------- */

await scenario("admin_fee_orders lists the period's collected orders with their fee, and nothing to anyone else", async () => {
  await actingAs("student_ledger");
  const ids = [];
  for (const pages of [4, 6]) {
    const { rows } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
      OPERATOR,
      JSON.stringify([{ name: "l.pdf", pages, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
    ]);
    ids.push(rows[0].id);
  }
  await actingAs("op_test");
  for (const id of ids) {
    for (const st of ["queued", "printing", "ready", "collected"]) {
      await db.query(`update public.orders set status = $2 where id = $1;`, [id, st]);
    }
  }
  // A refunded-in-full one must not appear; a partly refunded one must.
  await db.query(`update public.orders set refunded_at = now(), refund_amount = total, refund_note = 'test' where id = $1;`, [ids[0]]);
  await db.query(`update public.orders set refunded_at = now(), refund_amount = 1, refund_note = 'test' where id = $1;`, [ids[1]]);

  await actingAs("admin_test");
  const { rows } = await db.query(`select * from public.admin_fee_orders($1, now() - interval '1 hour');`, [OPERATOR]);
  const mine = rows.filter((r) => ids.includes(r.id));
  if (mine.length !== 1 || mine[0].id !== ids[1]) throw new Error(`expected the partly refunded order only, got ${mine.map((r) => r.id)}`);
  const cols = Object.keys(rows[0] ?? mine[0]);
  if (cols.some((c) => /user|name|file/i.test(c))) throw new Error(`the ledger leaks: ${cols}`);
  const { rows: sum } = await db.query(`select fee from public.fee_window($1, now() - interval '1 hour');`, [OPERATOR]);
  const listed = rows.filter((r) => !r.fee_settled_at).reduce((n, r) => n + Number(r.platform_fee), 0);
  if (Math.round(listed * 100) !== Math.round(Number(sum[0].fee) * 100)) throw new Error(`orders sum ${listed} vs window fee ${sum[0].fee}`);

  for (const who of ["student_ledger", "op_test"]) {
    await actingAs(who);
    const { rows: none } = await db.query(`select * from public.admin_fee_orders($1, now() - interval '1 hour');`, [OPERATOR]);
    if (none.length !== 0) throw new Error(`${who} saw the admin's ledger`);
  }
  await actingAs(null);
  await db.query(`delete from public.orders where user_id = 'student_ledger';`);
  return `one listed (the fully refunded one left out), no names, sums to fee_window; a student and a staffer see nothing`;
});

/* ---------- the student's X: cancelling their own order ---------- */

await scenario("a student cancels their own placed or queued order with the exact update the orders page sends", async () => {
  await actingAs("student_cancel");
  const place = async () => {
    const { rows } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
      OPERATOR,
      JSON.stringify([{ name: "c.pdf", pages: 3, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
    ]);
    return rows[0].id;
  };
  const placed = await place();
  // Exactly what cancelOrder() in lib/orders.ts sends.
  await db.query(`update public.orders set status = 'cancelled', note = 'Cancelled by you' where id = $1;`, [placed]);
  const { rows: a } = await db.query(`select status, cancelled_by, note from public.orders where id = $1;`, [placed]);
  if (a[0].status !== "cancelled" || a[0].cancelled_by !== "student") throw new Error(`placed → ${JSON.stringify(a[0])}`);

  // Queued (paid, waiting for the machine) is still theirs to cancel.
  const queued = await place();
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'queued' where id = $1;`, [queued]);
  await actingAs("student_cancel");
  await db.query(`update public.orders set status = 'cancelled', note = 'Cancelled by you' where id = $1;`, [queued]);
  const { rows: b } = await db.query(`select status, cancelled_by from public.orders where id = $1;`, [queued]);
  if (b[0].status !== "cancelled" || b[0].cancelled_by !== "student") throw new Error(`queued → ${JSON.stringify(b[0])}`);

  // Printing is not: the guard refuses any status but 'cancelled', and the
  // policy only lets placed/queued rows through, so nothing changes.
  const printing = await place();
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'queued' where id = $1;`, [printing]);
  await db.query(`update public.orders set status = 'printing' where id = $1;`, [printing]);
  await actingAs("student_cancel");
  let refused = false;
  try {
    await db.query(`update public.orders set status = 'cancelled', note = 'Cancelled by you' where id = $1;`, [printing]);
  } catch {
    refused = true;
  }
  const { rows: c } = await db.query(`select status from public.orders where id = $1;`, [printing]);
  if (c[0].status !== "printing") throw new Error(`printing was cancelled by the student`);
  await actingAs(null);
  await db.query(`delete from public.orders where user_id = 'student_cancel';`);
  return `placed and queued cancel, cancelled_by = student; printing stays printing${refused ? "" : " (RLS hides the row; the harness is superuser)"}`;
});

/* ---------- 0035: Printify collects, and owes the desk its share ---------- */

await scenario("an online order without a split is owed to the desk: bill less fee, less refunds in proportion, less payouts", async () => {
  await actingAs(null);
  await db.exec(`update public.platform_settings set fee_percent = 3, fee_min = 0 where id;`);
  const place = async () => {
    await actingAs("student_payout");
    const { rows } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
      OPERATOR,
      JSON.stringify([{ name: "p.pdf", pages: 20, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
    ]);
    return rows[0].id;
  };
  const pay = async (id, split) => {
    await actingAs(null);
    await db.query(`select public.gateway_begin($1, $2, $3);`, [id, `PF${id.replace(/-/g, "")}`, split]);
    const { rows } = await db.query(`select total, platform_fee from public.orders where id = $1;`, [id]);
    await db.query(`select public.gateway_paid($1, $2, $3, 'upi', now());`, [id, `cf_${id.slice(0, 8)}`, Number(rows[0].total)]);
    return { total: Number(rows[0].total), fee: Number(rows[0].platform_fee) };
  };

  // Admin turns collection on for the desk (no vendor): 'collect'.
  await actingAs("admin_test");
  await db.query(`select public.set_gateway_collect($1, true);`, [OPERATOR]);
  const { rows: st } = await db.query(`select gateway_status from public.operators where id = $1;`, [OPERATOR]);
  if (st[0].gateway_status !== "collect") throw new Error(`status ${st[0].gateway_status}`);
  await actingAs("op_test");
  let notAdmin = false;
  try {
    await db.query(`select public.set_gateway_collect($1, false);`, [OPERATOR]);
  } catch {
    notAdmin = true;
  }
  if (!notAdmin) throw new Error("staff turned collection off");

  const { rows: before } = await db.query(`select * from public.payout_balance($1);`, [OPERATOR]);
  const owed0 = Number(before[0].owed);

  // Three online orders: one plain, one half refunded, one that was split at source.
  const a = await place();
  const { total: ta, fee: fa } = await pay(a, false);
  const b = await place();
  const { total: tb, fee: fb } = await pay(b, false);
  await actingAs(null);
  await db.query(`select public.gateway_refunded($1, 'rf_b', $2, 'half wrong');`, [b, tb / 2]);
  const c = await place();
  await pay(c, true);
  // And one cancelled by the desk after paying — refunded, not owed.
  const d = await place();
  await pay(d, false);
  await actingAs("op_test");
  await db.query(`update public.orders set status = 'cancelled', cancelled_by = 'operator', note = 'out of paper' where id = $1;`, [d]);

  await actingAs("op_test");
  // a and b get printed and collected; the payout doesn't wait for that, the fee window does.
  for (const id of [a, b]) {
    for (const st of ["printing", "ready", "collected"]) {
      await db.query(`update public.orders set status = $2 where id = $1;`, [id, st]);
    }
  }
  const { rows: after } = await db.query(`select * from public.payout_balance($1);`, [OPERATOR]);
  const expected = Math.round(((ta - fa) + (tb - fb) * 0.5) * 100) / 100;
  const got = Math.round((Number(after[0].owed) - owed0) * 100) / 100;
  if (got !== expected) throw new Error(`owed rose by ${got}, expected ${expected} (a ${ta - fa}, half of b ${(tb - fb) / 2}, split c and cancelled d nothing)`);

  // The fee ledger owes nothing on them: fee retained at source.
  const { rows: fb0 } = await db.query(`select * from public.fee_balance($1);`, [OPERATOR]);
  const { rows: win } = await db.query(`select * from public.fee_window($1, now() - interval '1 hour');`, [OPERATOR]);
  if (Number(win[0].retained) < fa + fb) throw new Error(`retained ${win[0].retained} < ${fa + fb}`);
  void fb0;

  // A payout: admin only, written down, balance falls.
  let staffPaid = false;
  try {
    await db.query(`select public.record_payout($1, 5, 'try');`, [OPERATOR]);
  } catch {
    staffPaid = true;
  }
  if (!staffPaid) throw new Error("staff recorded a payout");
  await actingAs("admin_test");
  await db.query(`select public.record_payout($1, $2, 'UPI to the shop');`, [OPERATOR, expected]);
  const { rows: settled } = await db.query(`select * from public.payout_balance($1);`, [OPERATOR]);
  if (Math.round((Number(settled[0].balance) - Number(before[0].balance)) * 100) !== 0) throw new Error(`balance after payout ${settled[0].balance} vs before ${before[0].balance}`);
  const { rows: desks } = await db.query(`select share, paid_out, gateway_status from public.admin_payout_desks(now() - interval '1 hour') where operator_id = $1;`, [OPERATOR]);
  if (Math.round(Number(desks[0].share) * 100) < Math.round(expected * 100) || desks[0].gateway_status !== "collect") throw new Error(`admin row ${JSON.stringify(desks[0])}`);

  // The desk reads its own payouts; a student can't.
  await actingAs("op_test");
  const { rows: mine } = await db.query(`select amount, note from public.platform_payouts where operator_id = $1 order by created_at desc limit 1;`, [OPERATOR]);
  if (Number(mine[0].amount) !== expected) throw new Error("the desk can't see its payout");
  await actingAs("admin_test");
  await db.query(`select public.set_gateway_collect($1, false);`, [OPERATOR]);
  await actingAs(null);
  await db.query(`delete from public.platform_payouts where operator_id = $1;`, [OPERATOR]);
  await db.query(`delete from public.orders where user_id = 'student_payout';`);
  return `owed ${expected} = (a) full share + (b) half share; split (c) and cancelled (d) nothing; fee retained; payout by admin only, balance to zero; desk reads it`;
});

await scenario("the upload ceiling holds", async () => {
  await actingAs("student_test");
  // 500 MB is the cap; one file over it must be refused.
  let refused = false;
  try {
    await db.query(
      `insert into public.documents (user_id, name, storage_path, size_bytes, pages)
       values ('student_test', 'huge.pdf', 'student_test/huge.pdf', 600000000, 1);`,
    );
  } catch (error) {
    refused = /500 MB/.test(String(error?.message ?? error));
  }
  if (!refused) throw new Error("a 600 MB upload was accepted");
  return "600 MB refused, with the message the student sees";
});

/* ============================================================
   0036 — the grants, as the roles that hold them
   ============================================================ */

/**
 * Who may call what. Every non-trigger function in `public` must be here,
 * with exactly the roles that hold EXECUTE — a function added by a later
 * migration without a line here fails below, which is the point: the
 * decision of who calls it is made on purpose, once, and checked forever.
 */
const GRANTS = {
  // Policies evaluate these as the asking role.
  "clerk_id()": ["anon", "authenticated"],
  "is_staff(uuid)": ["anon", "authenticated"],
  "is_admin()": ["anon", "authenticated"],
  // Signed out.
  "operator_wait(uuid)": ["anon", "authenticated"],
  "board(uuid)": ["anon", "authenticated"],
  "desk_staff(text)": ["anon", "authenticated"],
  "desk_verify_pin(text,text,text)": ["anon", "authenticated"],
  "whoami()": ["anon", "authenticated"],
  // Signed in; each gates itself.
  "queue_status(uuid)": ["authenticated"],
  "queue_status_mine()": ["authenticated"],
  "my_totals()": ["authenticated"],
  "place_order(uuid,jsonb,timestamp with time zone)": ["authenticated"],
  "claim_document_access(uuid,text)": ["authenticated"],
  "operator_stats(uuid)": ["authenticated"],
  "operator_stats_range(uuid,timestamp with time zone,timestamp with time zone)": ["authenticated"],
  "adjust_stock(uuid,integer,integer,text)": ["authenticated"],
  "list_staff(uuid)": ["authenticated"],
  "add_staff(uuid,text)": ["authenticated"],
  "remove_staff(uuid,text)": ["authenticated"],
  "close_desk(uuid,numeric,text)": ["authenticated"],
  "set_my_pin(uuid,text)": ["authenticated"],
  "pair_device(uuid,text)": ["authenticated"],
  "revoke_device(uuid)": ["authenticated"],
  "create_invite(uuid,text)": ["authenticated"],
  "claim_invite(text)": ["authenticated"],
  "revoke_invite(uuid)": ["authenticated"],
  "create_operator(text,text)": ["authenticated"],
  "admin_desks()": ["authenticated"],
  "admins_exist()": ["authenticated"],
  "set_platform_fee(numeric,numeric,text,text,integer,text)": ["authenticated"],
  "record_settlement(uuid,numeric,text)": ["authenticated"],
  "fee_window(uuid,timestamp with time zone,timestamp with time zone)": ["authenticated"],
  "fee_balance(uuid)": ["authenticated"],
  "fee_status(uuid)": ["authenticated"],
  "admin_fee_desks(timestamp with time zone,timestamp with time zone)": ["authenticated"],
  "admin_fee_orders(uuid,timestamp with time zone,timestamp with time zone)": ["authenticated"],
  "apply_for_desk(text,text,text,text,text,text)": ["authenticated"],
  "withdraw_application(uuid)": ["authenticated"],
  "approve_application(uuid,text)": ["authenticated"],
  "reject_application(uuid,text)": ["authenticated"],
  "my_application()": ["authenticated"],
  "admin_applications(text)": ["authenticated"],
  "shut_operator(uuid,text)": ["authenticated"],
  "restore_operator(uuid)": ["authenticated"],
  "payout_balance(uuid)": ["authenticated"],
  "payout_window(uuid,timestamp with time zone,timestamp with time zone)": ["authenticated"],
  "record_payout(uuid,numeric,text)": ["authenticated"],
  "admin_payout_desks(timestamp with time zone,timestamp with time zone)": ["authenticated"],
  "set_gateway_collect(uuid,boolean)": ["authenticated"],
  // The server's.
  "claim_notifications(integer)": [],
  "complete_notification(bigint,text,text)": [],
  "gateway_begin(uuid,text,boolean)": [],
  "gateway_paid(uuid,text,numeric,text,timestamp with time zone)": [],
  "gateway_refunded(uuid,text,numeric,text)": [],
  // Internal: called from definer bodies, which run as their owner.
  "assert_server()": [],
  "is_server()": [],
  "can_invite_for(uuid)": [],
  "new_join_code()": [],
  "pin_digest(text,text)": [],
  "platform_fee_for(numeric,numeric,numeric)": [],
  "price_line(integer,integer,jsonb,operators,double precision)": [],
  "to_paise(double precision)": [],
  "desk_share(orders)": [],
};

await scenario("every function is granted to exactly who calls it, and nothing to PUBLIC", async () => {
  const { rows } = await db.query(`
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as raw,
           p.proname || '(' || array_to_string(p.proargtypes::regtype[], ',') || ')' as sig,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
           has_function_privilege('service_role', p.oid, 'execute') as service_role,
           coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false) as to_public
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_type t on t.oid = p.prorettype
     where n.nspname = 'public' and p.prokind = 'f' and t.typname <> 'trigger'
     order by 1;`);
  const problems = [];
  const seen = new Set();
  for (const f of rows) {
    seen.add(f.sig);
    const want = GRANTS[f.sig];
    if (!want) {
      problems.push(`${f.sig}: not in GRANTS — decide who may call it`);
      continue;
    }
    if (f.to_public) problems.push(`${f.sig}: PUBLIC may execute`);
    for (const role of ["anon", "authenticated"]) {
      if (f[role] !== want.includes(role)) problems.push(`${f.sig}: ${role} ${f[role] ? "may" : "may not"} execute`);
    }
    if (!f.service_role) problems.push(`${f.sig}: service_role may not execute`);
  }
  for (const sig of Object.keys(GRANTS)) if (!seen.has(sig)) problems.push(`${sig}: in GRANTS but not in the database`);
  if (problems.length) throw new Error(problems.join("; "));
  // A function made after 0036 must start with nothing.
  await db.exec(`create or replace function public._probe_0036() returns int language sql as $$ select 1 $$;`);
  const { rows: probe } = await db.query(`
    select has_function_privilege('anon', 'public._probe_0036()', 'execute') as anon,
           has_function_privilege('authenticated', 'public._probe_0036()', 'execute') as authenticated,
           has_function_privilege('service_role', 'public._probe_0036()', 'execute') as service_role;`);
  await db.exec(`drop function public._probe_0036();`);
  if (probe[0].anon || probe[0].authenticated) throw new Error("a new function is executable by the API roles by default");
  if (!probe[0].service_role) throw new Error("a new function isn't executable by the server by default");
  return `${rows.length} functions match; a new one starts closed to anon and authenticated, open to the server`;
});

await scenario("the notification queue answers only the server, in grant and in body", async () => {
  const asAnon = await refused("anon", null, `select * from public.claim_notifications(1);`);
  if (!/permission denied/.test(asAnon ?? "")) throw new Error(`anon: ${asAnon ?? "allowed"}`);
  const asStudent = await refused("authenticated", "student_test", `select * from public.claim_notifications(1);`);
  if (!/permission denied/.test(asStudent ?? "")) throw new Error(`student: ${asStudent ?? "allowed"}`);
  const done = await refused("authenticated", "student_test", `select public.complete_notification(1, 'sent', 'x');`);
  if (!/permission denied/.test(done ?? "")) throw new Error(`complete as student: ${done ?? "allowed"}`);
  // The body's own check: even with the grant, a Clerk token is refused.
  await actingAs("student_test");
  let inBody = null;
  try {
    await db.query(`select * from public.claim_notifications(1);`);
  } catch (error) {
    inBody = String(error?.message ?? error).split("\n")[0];
  }
  if (!/Only Printify's server/.test(inBody ?? "")) throw new Error(`body with a sub: ${inBody ?? "allowed"}`);
  await actingAs(null);
  await db.query(`select * from public.claim_notifications(1);`);
  return "anon and a student: permission denied; a Clerk token inside the body: refused; the server: fine";
});

// A student with no orders yet: the ones above have used up student_test's hour.
const LOCK_STUDENT = "student_lock";

await scenario("token_sequence is nobody's to read or write", async () => {
  const { rows } = await db.query(`select relrowsecurity from pg_class where oid = 'public.token_sequence'::regclass;`);
  if (!rows[0].relrowsecurity) throw new Error("RLS is off");
  const read = await refused("authenticated", "student_test", `select * from public.token_sequence;`);
  if (!/permission denied/.test(read ?? "")) throw new Error(`read: ${read ?? "allowed"}`);
  const write = await refused("authenticated", "student_test", `update public.token_sequence set last_value = 0;`);
  if (!/permission denied/.test(write ?? "")) throw new Error(`write: ${write ?? "allowed"}`);
  const asAnon = await refused("anon", null, `select * from public.token_sequence;`);
  if (!/permission denied/.test(asAnon ?? "")) throw new Error(`anon: ${asAnon ?? "allowed"}`);
  // The token trigger (security definer) still gets through.
  await actingAs(LOCK_STUDENT);
  const { rows: placed } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "seq.pdf", pages: 1, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
  ]);
  const { rows: tok } = await db.query(`select token from public.orders where id = $1;`, [placed[0].id]);
  if (!tok[0]?.token) throw new Error("no token after the lockdown");
  await actingAs(null);
  await db.query(`delete from public.orders where id = $1;`, [placed[0].id]);
  return "RLS on, no grants; the trigger still hands out tokens";
});

await scenario("online payment is switched on by the admin or the server, never by the desk", async () => {
  await actingAs(null);
  await db.query(`update public.operators set gateway_status = 'off', gateway_vendor_id = null where id = $1;`, [OPERATOR]);
  // Staff, through the policy that lets them edit their own desk.
  const byStaff = await refused("authenticated", "op_test", `update public.operators set gateway_status = 'collect' where id = $1;`, [OPERATOR]);
  if (!/Only Printify switches/.test(byStaff ?? "")) throw new Error(`staff: ${byStaff ?? "allowed"}`);
  const vendor = await refused("authenticated", "op_test", `update public.operators set gateway_vendor_id = 'desk_x' where id = $1;`, [OPERATOR]);
  if (!/Only Printify switches/.test(vendor ?? "")) throw new Error(`staff vendor: ${vendor ?? "allowed"}`);
  // Staff can still run their desk.
  const open = await refused("authenticated", "op_test", `update public.operators set status_note = 'back at 3' where id = $1;`, [OPERATOR]);
  if (open) throw new Error(`staff's own note refused: ${open}`);
  // The admin, through the function.
  await actingAs("admin_test");
  await db.query(`select public.set_gateway_collect($1, true);`, [OPERATOR]);
  // The server, through the vendor route's plain update.
  await actingAs(null);
  await db.query(`update public.operators set gateway_vendor_id = 'desk_test', gateway_status = 'pending' where id = $1;`, [OPERATOR]);
  const { rows } = await db.query(`select gateway_status, gateway_vendor_id from public.operators where id = $1;`, [OPERATOR]);
  await db.query(`update public.operators set gateway_status = 'off', gateway_vendor_id = null, status_note = null where id = $1;`, [OPERATOR]);
  if (rows[0].gateway_status !== "pending" || rows[0].gateway_vendor_id !== "desk_test") throw new Error("the server's update didn't land");
  return "staff refused on both columns and still edit the rest; admin via set_gateway_collect and the server's update go through";
});

await scenario("a student can't back-date an order or mark it paid online; staff can't reprice it", async () => {
  await actingAs(LOCK_STUDENT);
  const { rows: placed } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "pin.pdf", pages: 4, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
  ]);
  const id = placed[0].id;
  const before = (await db.query(`select created_at, total, user_id from public.orders where id = $1;`, [id])).rows[0];
  // As the real role, through the cancel policy that lets a student update their own row.
  const backdate = await refused("authenticated", LOCK_STUDENT,
    `update public.orders set created_at = now() - interval '1 day', total = 1, user_id = 'someone_else' where id = $1;`, [id]);
  if (backdate) throw new Error(`the update itself was refused (${backdate}) — it should be silently pinned`);
  const after = (await db.query(`select created_at, total, user_id from public.orders where id = $1;`, [id])).rows[0];
  if (String(after.created_at) !== String(before.created_at)) throw new Error("created_at moved");
  if (Number(after.total) !== Number(before.total)) throw new Error("total moved");
  if (after.user_id !== LOCK_STUDENT) throw new Error("user_id moved");
  const online = await refused("authenticated", LOCK_STUDENT,
    `update public.orders set payment_method = 'gateway', payment_claimed_at = now() where id = $1;`, [id]);
  if (!/recorded by Printify/.test(online ?? "")) throw new Error(`gateway claim: ${online ?? "allowed"}`);
  // Staff: the bill, the owner and the student's claim are pinned; the desk's own fields aren't.
  const reprice = await refused("authenticated", "op_test",
    `update public.orders set total = 999, user_id = 'op_test', payment_claimed_amount = 0 where id = $1;`, [id]);
  if (reprice) throw new Error(`staff update refused (${reprice}) — it should be pinned`);
  const s = (await db.query(`select total, user_id, payment_claimed_amount from public.orders where id = $1;`, [id])).rows[0];
  if (Number(s.total) !== Number(before.total) || s.user_id !== LOCK_STUDENT || s.payment_claimed_amount !== null) throw new Error("staff moved a pinned column");
  const refund = await refused("authenticated", "op_test", `update public.orders set refund_amount = 5000, refunded_at = now() where id = $1;`, [id]);
  if (!/between nothing and the bill/.test(refund ?? "")) throw new Error(`oversized refund: ${refund ?? "allowed"}`);
  const ok = await refused("authenticated", "op_test", `update public.orders set status = 'queued', payment_received = 10 where id = $1;`, [id]);
  if (ok) throw new Error(`staff's own confirm refused: ${ok}`);
  await actingAs(null);
  await db.query(`delete from public.orders where id = $1;`, [id]);
  return "created_at/total/user_id pinned for the student, 'gateway' refused; total/user_id/claim pinned for staff, refund bounded, confirm fine";
});

await scenario("as the API roles, RLS shows each what's theirs and nothing more", async () => {
  await actingAs(LOCK_STUDENT);
  const { rows: placed } = await db.query(`select public.place_order($1, $2::jsonb) as id;`, [
    OPERATOR,
    JSON.stringify([{ name: "rls.pdf", pages: 2, colour_pages: 0, config: { copies: 1, sides: "single" } }]),
  ]);
  const id = placed[0].id;
  const count = async (role, user, sql) => {
    await asRole(role, user);
    try {
      return (await db.query(sql)).rows.length;
    } finally {
      await asRoot();
    }
  };
  const anonOrders = await count("anon", null, `select id from public.orders;`);
  const anonProfiles = await count("anon", null, `select id from public.profiles;`);
  const anonOps = await count("anon", null, `select id from public.operators;`);
  const anonPins = await refused("anon", null, `select * from public.staff_pins;`);
  const strangerOrders = await count("authenticated", "someone_else", `select id from public.orders where id = '${id}';`);
  const ownOrders = await count("authenticated", LOCK_STUDENT, `select id from public.orders where id = '${id}';`);
  const staffOrders = await count("authenticated", "op_test", `select id from public.orders where id = '${id}';`);
  const strangerPins = await count("authenticated", "someone_else", `select * from public.staff_pins;`);
  const strangerDevices = await count("authenticated", "someone_else", `select * from public.desk_devices;`);
  const strangerAdmins = await count("authenticated", "someone_else", `select * from public.admins;`);
  const strangerNotes = await count("authenticated", "someone_else", `select * from public.notifications;`);
  await actingAs(null);
  await db.query(`delete from public.orders where id = $1;`, [id]);
  if (anonOrders || anonProfiles) throw new Error(`anon sees ${anonOrders} orders, ${anonProfiles} profiles`);
  if (!anonOps) throw new Error("anon can't see the desks");
  if (anonPins && !/permission denied/.test(anonPins)) throw new Error(`anon on staff_pins: ${anonPins}`);
  if (strangerOrders) throw new Error("a stranger sees the order");
  if (ownOrders !== 1) throw new Error("the owner can't see their order");
  if (staffOrders !== 1) throw new Error("the desk can't see its order");
  if (strangerPins || strangerDevices || strangerAdmins || strangerNotes) throw new Error("a stranger sees pins/devices/admins/notifications");
  return "anon: desks yes, orders/profiles no; the order: owner and desk yes, stranger no; pins, devices, admins, notifications: nothing";
});

await actingAs(null);

// Last, because it needs every table the scenarios above filled.
await scenario("reset.sql empties every table and names every table", async () => {
  const reset = readFileSync(join(here, "..", "supabase", "reset.sql"), "utf8");
  // Tables the script says it keeps (configuration, not data) are expected to
  // exist and to survive; everything else must be named in the truncate.
  const keeps = [...reset.matchAll(/^-- keeps public\.(\w+)/gm)].map((m) => m[1]);
  const body = reset.replace(/^--.*$/gm, "");
  const named = [...body.matchAll(/public\.(\w+)/g)].map((m) => m[1]).sort();
  const { rows: existing } = await db.query(
    `select tablename from pg_tables where schemaname = 'public' order by 1`,
  );
  const real = existing.map((r) => r.tablename).sort();
  const missing = real.filter((t) => !named.includes(t) && !keeps.includes(t));
  const stale = [...named, ...keeps].filter((t) => !real.includes(t));
  if (missing.length) throw new Error(`reset.sql doesn't mention: ${missing.join(", ")}`);
  if (stale.length) throw new Error(`reset.sql names tables that don't exist: ${stale.join(", ")}`);

  const before = await db.query(`select count(*)::int as n from public.orders`);
  if (before.rows[0].n === 0) throw new Error("nothing to empty — the scenarios above left no orders");
  await db.exec(reset);
  const leftovers = [];
  for (const t of real) {
    const { rows } = await db.query(`select count(*)::int as n from public.${t}`);
    if (keeps.includes(t)) {
      if (rows[0].n === 0) throw new Error(`${t} was emptied, but reset.sql says it keeps it`);
    } else if (rows[0].n > 0) leftovers.push(`${t} (${rows[0].n})`);
  }
  if (leftovers.length) throw new Error(`still populated: ${leftovers.join(", ")}`);
  return `${real.length} tables, ${before.rows[0].n} orders gone, all counts zero, ${keeps.join(", ")} kept`;
});

console.log(
  failed === 0
    ? "\nPASS - every migration applies, re-applies, and the triggers fire"
    : `\nFAIL - ${failed} problem(s)`,
);
console.log(
  "\nCovered as the real roles (set role anon / authenticated): every function's\n" +
    "grants, the server-only queue, token_sequence, the gateway switch, the order\n" +
    "pins, and row visibility on orders, profiles, pins, devices, admins and\n" +
    "notifications. Other policies are still exercised as superuser, which bypasses\n" +
    "RLS; check:rls runs them all against the live project. Storage behaviour\n" +
    "beyond the table shape, and realtime delivery, still need a real project.",
);

await db.close();
process.exit(failed === 0 ? 0 : 1);
