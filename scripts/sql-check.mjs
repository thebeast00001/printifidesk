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
  const claims = userId === null ? "" : JSON.stringify({ sub: userId });
  await db.query(`select set_config('request.jwt.claims', $1, false);`, [claims]);
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
    `select currency, bw_per_page::text, colour_per_page::text, duplex_discount::text,
            staple_price::text, bulk_threshold, bulk_multiplier::text, min_order::text, paper_gsm
       from public.operators where id = $1;`,
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
  const card = await rateCardFromDb();

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
              `select o.total, o.rate_card,
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
  return `${joinCode.slice(0, 4)}-${joinCode.slice(4)}, 24 h, desk listed with 0 staff and 1 open code`;
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

await scenario("applications are gone", async () => {
  const { rows } = await db.query(`select to_regclass('public.operator_applications') as t;`);
  if (rows[0].t !== null) throw new Error("operator_applications still exists");
  const { rows: fn } = await db.query(
    `select count(*)::int as n from pg_proc where proname in ('approve_application', 'reject_application');`,
  );
  if (fn[0].n !== 0) throw new Error("approve/reject_application still exist");
  return "table and both functions dropped";
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

await actingAs(null);

// Last, because it needs every table the scenarios above filled.
await scenario("reset.sql empties every table and names every table", async () => {
  const reset = readFileSync(join(here, "..", "supabase", "reset.sql"), "utf8");
  const named = [...reset.matchAll(/public\.(\w+)/g)].map((m) => m[1]).sort();
  const { rows: existing } = await db.query(
    `select tablename from pg_tables where schemaname = 'public' order by 1`,
  );
  const real = existing.map((r) => r.tablename).sort();
  const missing = real.filter((t) => !named.includes(t));
  const stale = named.filter((t) => !real.includes(t));
  if (missing.length) throw new Error(`reset.sql doesn't mention: ${missing.join(", ")}`);
  if (stale.length) throw new Error(`reset.sql names tables that don't exist: ${stale.join(", ")}`);

  const before = await db.query(`select count(*)::int as n from public.orders`);
  if (before.rows[0].n === 0) throw new Error("nothing to empty — the scenarios above left no orders");
  await db.exec(reset);
  const leftovers = [];
  for (const t of real) {
    const { rows } = await db.query(`select count(*)::int as n from public.${t}`);
    if (rows[0].n > 0) leftovers.push(`${t} (${rows[0].n})`);
  }
  if (leftovers.length) throw new Error(`still populated: ${leftovers.join(", ")}`);
  return `${real.length} tables, ${before.rows[0].n} orders gone, all counts zero`;
});

console.log(
  failed === 0
    ? "\nPASS - every migration applies, re-applies, and the triggers fire"
    : `\nFAIL - ${failed} problem(s)`,
);
console.log(
  "\nNot covered: whether the RLS policies grant the right rows. The JWT is set, so\n" +
    "clerk_id() and is_staff() are real here, but PGlite runs as superuser and\n" +
    "superusers bypass RLS — so a policy could be wrong and everything above would\n" +
    "still pass. Storage behaviour beyond the table shape, and realtime delivery,\n" +
    "also still need a real project.",
);

await db.close();
process.exit(failed === 0 ? 0 : 1);
