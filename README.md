# Print Counter

Campus printing without the queue. Upload from your phone, get a token, collect a
printed set.

Product and engineering plan: [docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md).
Original standalone design prototype: [design/print-counter.html](design/print-counter.html).

```bash
npm run dev
```

## No mock data

Nothing on the site is seeded, simulated or placeholder. Every figure is read
from a row, so before the backend is set up the app reports itself as offline
rather than inventing content: the header says *Operator offline*, the status
capsule says *Tracking is offline*, the widgets show `0`, and the file shelf is
empty. That's the intended behaviour, not a bug.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (App Router, Turbopack) | RSC by default |
| Authentication | Clerk | Real accounts; Supabase verifies its JWT |
| Database, storage, realtime | Supabase | Postgres with RLS keyed to the Clerk subject |
| Styling | Tailwind v4 | Tokens in `@theme inline`, so `bg-paper` follows the theme |
| State transitions | `motion` (Framer Motion 13) | `layout` / `layoutId` for anything that morphs |
| Orchestration | GSAP 3 + `@gsap/react` | Timelines, staggers, retargetable numeric tweens |
| PDF analysis | `pdfjs-dist` | Page counts and per-page colour, in the browser |
| Pricing | operator rows | Each operator sets their own rates; nothing is hardcoded |
| Sheet | `vaul` | Real drag-to-dismiss physics, Radix a11y underneath |
| Client state | `zustand` | Only the sheet and overlays — never order data |
| Theme | `next-themes` | Class strategy, system default |

**motion** owns *state* transitions — an element changing shape, position or
presence. **GSAP** owns *time* — sequences and numeric tweens that need
retargeting mid-flight, like the progress fill that changes target when a
realtime update lands before the last tween finished.

## Two sites

Students use **`printifi.store`**; the desk uses **`desk.printifi.store`**. One
codebase, one database, **two Clerk applications, two deployments** — a
student account and a desk account are different accounts, in different
user lists, with different sign-up rules, and signing in on one site says
nothing to the other. [`lib/surface.ts`](lib/surface.ts) is the whole
routing rule: a pure table the middleware, the server layout and the
browser all read, and `check:features` exercises every row of it.

| | Student site | Desk site |
|---|---|---|
| Pages | `/`, `/orders`, `/profile`, `/settings` | `/` (queue), `/takings`, `/settings`, `/join` — and the admin's `/admin` (fees), `/admin/desks`, `/diagnostics`, with a dock of their own |
| Sign-in | one **Google** button, nothing else | **email + password**; create account; forgot password by emailed code — or a PIN on a paired device |
| Chrome | status island, rotating headline, student dock | desk header, desk dock, no student anything |
| Installs as | "Printify", portrait, `/icon-*.png` | "Printify Desk", any orientation, `/desk-icon-*.png` |
| Push | "your job is ready" | "new order A03 — 12 pages, ₹28", to devices subscribed *from the desk* |
| Stray page | `/operator…`, `/join`, `/admin` → desk host | `/orders`, `/profile` → student host |

Both doors are Clerk custom flows, so Clerk still does the hashing, the
breach check, the emailed codes and the session. Signing out of the desk
lands on the desk's door.

### Keeping the two repos identical

If the desk is deployed from a second repository, that repository must only
ever be pulled into. From the desk checkout:

```bash
npm run sync:desk
```

It refuses to run with uncommitted changes or with commits the student
repo lacks, then fast-forwards from `upstream` and pushes to `origin`.
(Two Vercel projects from one repo need none of this.)

### Two Clerk applications

The code never names an instance — it reads `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
and `CLERK_SECRET_KEY` — so the desk site is the same repo deployed again
with a second Clerk application's keys. Nothing is copied, so nothing
drifts. `staff`, `admins`, RLS and the PIN route only ever see a `sub`, and
a desk user's `sub` comes from the desk application.

1. **Clerk:** create a second application, *Printify Desk*. Turn on email +
   password (and email verification codes); leave Google off. Sessions →
   lifetime ~30 days. Configure → Integrations → **Supabase**, same as the
   student one, so its tokens carry `"role": "authenticated"`.
2. **Supabase → Authentication → Third-Party Auth:** add the desk
   application's Clerk domain as a second Clerk entry. The hosted dashboard
   accepts more than one; the local CLI's `config.toml` doesn't yet
   ([supabase/cli#4679](https://github.com/supabase/cli/issues/4679)), which
   only matters for `supabase start`.
3. **Vercel:** two projects from this one repo.
   - *printify* — the student site: the existing Clerk keys,
     `NEXT_PUBLIC_DESK_HOST=desk.printifi.store`,
     `NEXT_PUBLIC_SITE_HOST=printifi.store`.
   - *printify-desk* — the desk site: the desk application's keys, the same
     two host variables, and **`NEXT_PUBLIC_SURFACE=desk`** so its preview
     URLs are the desk too. Same Supabase, VAPID and notify-secret values.
   Clerk namespaces its cookies per application, so the two can share a
   root domain ([changelog](https://clerk.com/changelog/2024-09-09-multiple-apps-same-domain)).
4. **Locally**, a second checkout of the same repo (e.g. `../printifydesk`)
   with its own `.env.local` — the desk keys and `NEXT_PUBLIC_SURFACE=desk`
   — runs as `npm run dev -- -p 3100` next to the student one on 3000.
   Next.js allows one dev server per directory, which is the only reason
   for the second folder; `git pull` in both keeps them identical.

With `NEXT_PUBLIC_DESK_HOST` unset and nothing pinned, both sites share one
host and one Clerk application, with the desk under `/operator` — that is
how a bare `localhost:3000` runs, and `desk.localhost:3000` shows the desk
site there without any config. Nothing about the pages differs between the
modes, only where they are addressed from: `/operator/takings` on one host
is `/takings` on the desk's.

## Setup

Authentication is **Clerk**; Postgres, storage and realtime are **Supabase**.
Supabase never owns a user — it verifies Clerk's JWT and reads the subject
claim. Four steps, in this order:

**1. Clerk → Configure → Integrations → enable Supabase.**
This makes Clerk add `"role": "authenticated"` to its session tokens, which is
what Supabase's RLS needs. Without it every policy silently denies.

**2. Supabase → Authentication → Third-Party Auth → add Clerk.**
Domain:

```
factual-teal-4113.clerk.accounts.dev
```

**3. Supabase → SQL Editor →** run both migrations in order:
[`0001_init.sql`](supabase/migrations/0001_init.sql),
[`0002_profiles_and_pages.sql`](supabase/migrations/0002_profiles_and_pages.sql),
[`0003_rename_operator.sql`](supabase/migrations/0003_rename_operator.sql),
[`0004_operator_open.sql`](supabase/migrations/0004_operator_open.sql),
[`0005_operator_pricing.sql`](supabase/migrations/0005_operator_pricing.sql),
[`0006_operators_pickup_notifications.sql`](supabase/migrations/0006_operators_pickup_notifications.sql),
[`0007_operator_portal.sql`](supabase/migrations/0007_operator_portal.sql),
[`0008_claim_first_admin.sql`](supabase/migrations/0008_claim_first_admin.sql),
[`0009_upi_payment.sql`](supabase/migrations/0009_upi_payment.sql),
[`0010_realtime.sql`](supabase/migrations/0010_realtime.sql),
[`0011_operator_files_and_ops.sql`](supabase/migrations/0011_operator_files_and_ops.sql),
[`0012_rate_limit.sql`](supabase/migrations/0012_rate_limit.sql),
[`0013_per_item_config_and_reports.sql`](supabase/migrations/0013_per_item_config_and_reports.sql),
[`0014_hardening.sql`](supabase/migrations/0014_hardening.sql),
[`0015_desk_tools.sql`](supabase/migrations/0015_desk_tools.sql),
[`0016_handover_code.sql`](supabase/migrations/0016_handover_code.sql),
[`0017_paise_and_rate_snapshot.sql`](supabase/migrations/0017_paise_and_rate_snapshot.sql),
[`0018_desk_devices.sql`](supabase/migrations/0018_desk_devices.sql),
[`0019_join_codes.sql`](supabase/migrations/0019_join_codes.sql),
[`0020_admin_by_hand.sql`](supabase/migrations/0020_admin_by_hand.sql),
[`0021_desk_push.sql`](supabase/migrations/0021_desk_push.sql),
[`0022_platform_fee.sql`](supabase/migrations/0022_platform_fee.sql),
[`0023_owner_code.sql`](supabase/migrations/0023_owner_code.sql),
then [`0024_applications.sql`](supabase/migrations/0024_applications.sql),
then [`0025_fee_lock.sql`](supabase/migrations/0025_fee_lock.sql).

These are **SQL** — they go in the Supabase dashboard's SQL editor
(`Project → SQL Editor → New query`), not a terminal.

**Starting over.** [`supabase/reset.sql`](supabase/reset.sql) empties every
table and touches nothing else — no schema, no policies, no functions. It
names each table rather than looping, and `check:sql` asserts the list matches
what the migrations create. Files live in Storage and accounts live in Clerk,
so those are emptied from their own dashboards; the script's header says how.
The first sign-in afterwards is a plain student: `/diagnostics` → copy the
`INSERT` → run it in the SQL editor, `/admin` → *New desk* → an owner code,
`/join` with that code, and the desk exists again with you on it.

Run them **in order** — 0003 renames things 0002 created, and 0004 rewrites a
function 0003 defines. With Docker running you can execute the whole set against
a throwaway Postgres before touching your project:

```bash
npm run check       # types, pricing, phone + slot logic, and the SQL below
npm run check:sql   # just the migrations
```

`check:sql` **actually executes them**, with no Docker and no Supabase project.
[PGlite](https://pglite.dev) is Postgres compiled to WebAssembly — the same
parser and the same PL/pgSQL — so the harness boots one, stubs the handful of
Supabase objects the migrations touch (`auth.jwt()`, `storage.objects`, the
roles, the realtime publication), applies all twelve in order, applies them a
second time to catch anything that isn't idempotent, and then drives the
triggers through a real order:

- an insert gets a token
- the operator moves it to `queued` and the timeline appends
- a student with **no profile row** doesn't jam the queue
- a student **cannot** rewrite their own `total`, or fake a refund
- the operator **can** record a real one, and `operator_stats_range` counts it
- a 600 MB upload is refused by the ceiling

It switches identity with `set_config('request.jwt.claims', …)`, the same
setting PostgREST sets per request, so `clerk_id()` and `is_staff()` are the
real functions rather than mocks.

**What it does not prove:** whether the RLS policies grant the right rows.
PGlite runs as superuser and superusers bypass RLS, so a policy could be wrong
and every check above would still pass. That, storage behaviour, and realtime
delivery still need a real project.

`npm run check:migrations` is the older Docker version and does the same thing
against a throwaway container. Use it if you have Docker; `check:sql` needs
nothing.

Why this exists: for a long stretch Docker wouldn't start on the machine this
was built on, so the migrations were only ever *read*. Three separate errors
reached the Supabase SQL editor before anyone noticed — a reserved word used as
a column name, a renamed function parameter, and a `SELECT a, b.*, c.* INTO
x, y, z` that does not mean what it looks like. All three would have been caught
here in under a second.

### Two Postgres rules these migrations keep running into

`CREATE OR REPLACE FUNCTION` **cannot rename an input parameter** and **cannot
change the columns of a `RETURNS TABLE`** — both are part of the function's
identity, so the function must be dropped first. And a function can't be dropped
while an RLS policy calls it, so those policies come down before it and go back
up after. `0003` does exactly that dance around `is_staff`.

Also: `position` is a reserved word and can't name a `RETURNS TABLE` column,
which is why `queue_status` returns `place`.

**4. Make yourself the admin — by hand.** Sign in once, open
**`/diagnostics`**, and copy the `INSERT` it shows (it has your real Clerk id
in it). Run it in the Supabase SQL editor:

```sql
insert into public.admins (user_id) values ('user_...');
```

There is no button for this, on purpose. Since `0020` nothing inside the app
can write the `admins` table — no function, no policy — so the only way to
become admin is SQL run by whoever can open the project's dashboard. That is
the boundary: your Supabase login is the admin key.

Every desk after that is created by you at `/admin`; its owner joins with the
code you hand them, and from then on **staff is the desk's business** — an
admin can make a code only for a desk with nobody on it, sees how many people
a desk has but never who, and can't add or remove anyone.

Credentials live in `.env.local` (gitignored; `.env.example` documents the
shape). The Supabase key and Clerk publishable key are safe in the browser;
`CLERK_SECRET_KEY` is server-only and must never be committed.

### `/diagnostics` — setup checks

Visit **`/diagnostics`** while signed in. It reports whether Supabase and Clerk
are wired up, whether your profile row exists, whether you're an operator, and
what Postgres actually sees — JWT subject, JWT role, database role. It also
prints the exact `insert into public.staff` statement with your id filled in.

The route is deliberately **not linked from anywhere in the app**: a student
never configures a backend. Everything it shows is scoped to your own session.

**If the profiles table stays empty**, that's a rejected write with nothing
saying so. Check `/diagnostics` — if **jwt role** is anything other than
`authenticated`, step 1 hasn't been done, so every RLS policy denies, including
the one that creates your profile row.

### Why user ids are text, not uuid

Users live in Clerk, so there is no `auth.users` row to reference and
`auth.uid()` returns null — it tries to parse a uuid out of a `user_...`
string. Every table stores Clerk's id as `text`, and every policy compares
against `public.clerk_id()`, which reads `auth.jwt() ->> 'sub'`.

## How tracking works

There is no demo loop. An order moves because a person at the operator moved it.

```
student                          database                        operator
──────────────────────────────────────────────────────────────────────────
Send to operator ─insert─▶ orders (status: placed)
                             ├─ trigger assigns token  A01, A02…
                             └─ trigger writes an order_events row
                                       │
                                  realtime push
                                       ▼
 status capsule updates                                /operator shows the job
                                                                │
                             orders.status ◀──update── "Payment taken"
                             └─ trigger writes another event
                                       │
                                  realtime push
                                       ▼
 "In queue, position 2 · about 6 min"
```

- **Tokens** come from `assign_order_token()`, a per-operator daily sequence, so
  two students can never be handed the same one. The client never invents one.
- **The timeline** is written by a trigger on `orders`, never by a client, so it
  cannot disagree with the order it describes.
- **Queue position and wait** come from `queue_status()`. A student can't read
  other people's orders, but a security-definer function can still tell them how
  many are ahead. Wait is `pages ahead ÷ the operator's configured throughput`.
- **Progress** is a real fraction where one exists (pages ahead vs pages
  remaining) and a fixed step per status otherwise. It never advances on a timer.
- **Realtime** is one shared channel with a subscriber registry. supabase-js
  returns the *same* channel object for a repeated topic name and rejects new
  `postgres_changes` callbacks after `subscribe()`, so several hooks each opening
  `"tracking"` throws.

### Prices belong to the operator

There is no rate constant in the app. `operators` carries the whole rate card —
per-page black & white and colour, a duplex discount, one bulk slab, staple
price, minimum job, paper weight and measured pages-per-minute — and the
operator edits it on `/operator`, previewed against two real example jobs before
saving. A check constraint rejects negative prices and out-of-range discounts.

`quote()` in [`lib/pricing.ts`](lib/pricing.ts) is pure and takes the card as an
argument, so the same function prices the browser quote and can re-price the
order server-side. `npm run check:pricing` exercises it against two operators
with different rates.

Finishing is only what a desk does while you wait — **staple or loose**. Spiral
and soft binding are a separate job with a separate turnaround, so they're out
until that's modelled.

### Becoming an operator — apply, then a code

Two ways onto a desk, both ending in a code:

- **Joining someone's desk:** they make a join code under *Settings →
  Staff*; you enter it.
- **Starting your own** (`0024`): sign in to the desk site — a desk account
  is what keeps your orders and everything else yours — and **apply**: what
  students should see, campus, where, your phone, the printer, a note.
  The admin reads it at `/admin/applications`. **Accepting creates the desk
  and mints an owner code for your account only**, in one transaction; the
  admin hands you the code (it stays readable on the application until
  it's used); you enter it in the same box; the desk is yours. A rejection
  carries a reason and you can apply again. One pending application per
  person; nobody already on a desk can apply.

The admin can also create a desk directly at `/admin/desks` and hand out
its owner code — or take an empty one with *Run it myself*.

`/operator` therefore shows one of three things: a sign-in prompt, the
**join-code box with the application under it**, or the portal.

New desks start **closed** (`is_open = false`) with nobody on staff, so
nothing goes live until the owner has joined and opened it.

**Join codes** (`staff_invites`, `0019`): made by staff of the desk or an
admin; eight characters from an alphabet without 0/O or 1/I, typed in any
case with or without the dash; one use; 24 hours; revocable; ten open per
desk at most. A lost **owner code** is re-read, not recovered: it stays on
the desk's row in `/admin` until the owner joins, and making a new one
cancels the old (`0023`) — an empty desk has exactly one live code. Claiming is a tap, never a page load — a code can be burned by
the wrong person. Twenty wrong guesses in an hour and that account waits an
hour; the guess limiter is a row per attempt that survives the refusal, which
is why `claim_invite` returns a verdict instead of raising. After joining, the
page offers the PIN straight away, because the next stop is the counter
device.

### The operator portal

Split by what needs doing rather than by status name:

| Tab | What's in it |
|---|---|
| **New** | Orders placed but not paid for — accept or decline |
| **Printing** | Work in hand, advancing through print → binding → ready |
| **Ready** | Waiting to be collected |
| **Scheduled** | Booked for later, not yet due |
| **History** | Collected, cancelled and failed |

Above them a live strip: waiting, printing, ready, done today, pages today,
taken today, and median turnaround — all from `operator_stats()`, aggregated in
Postgres rather than by pulling every order.

Per order: accept (payment taken), decline with a reason the student sees,
advance through the statuses, flag priority (which re-sorts the queue), a
private operator note, and an expandable detail showing each file with its page
selection written as ranges (`1–3, 7–8`). Search by token or filename. The whole
board updates over realtime, because the operator has their hands full.

Settings on the same page: the open/closed switch and the full rate card.

### Choosing an operator

Every operator sets their own prices and hours, so which one you print through
is a real decision. Settings → **Where you print** lists them with live rates and
open/closed state; the choice is stored on `profiles.default_operator_id` and
everything — the header wait, the quote, the order — follows it.

### Scheduled pickup

The print sheet offers **as soon as possible** or a booked slot. Slots are built
from that operator's own opening hours, in 30-minute steps, and exclude anything
that has already passed or that the machine can't finish in time — lead time is
`pages ÷ pages_per_minute + handling_minutes`. A check constraint keeps
`pickup_mode` and `pickup_at` consistent, and `operator_wait()` ignores
scheduled jobs until they're within 30 minutes of due, so a booking tomorrow
doesn't inflate today's quoted wait.

### WhatsApp notifications

A Postgres trigger queues a message into `notifications` whenever an order
reaches **queued**, **ready**, **failed** or **collected**. Delivery is a
separate step: `POST /api/notifications/dispatch` claims rows with
`for update skip locked` (so two calls can't double-send), sends via the
WhatsApp Cloud API, and writes back `sent` or `failed` **with the provider's own
error**. Settings shows those outcomes, so nothing claims delivery that didn't
happen.

It needs four server-side values in `.env.local`:

```
SUPABASE_SERVICE_ROLE_KEY=   # reads phone numbers; never goes to the browser
NOTIFY_WEBHOOK_SECRET=       # any long random string
WHATSAPP_PHONE_NUMBER_ID=    # developers.facebook.com → your app → WhatsApp
WHATSAPP_ACCESS_TOKEN=
```

`GET /api/notifications/dispatch` reports which of those are set. Until they
are, messages queue and are marked `failed: WhatsApp is not configured` rather
than silently disappearing.

To fire it automatically, add a Supabase Database Webhook on
`public.notifications` (insert) pointing at
`https://<your-domain>/api/notifications/dispatch` with header
`x-notify-secret: <NOTIFY_WEBHOOK_SECRET>`. Polling the same endpoint on a
schedule works as a backstop.

**Not verified end to end.** The queueing, claiming and write-back are real
code, but no message has actually been sent from here — that needs a WhatsApp
Business number and a token I don't have.

### Push notifications

WhatsApp is the fallback, not the fast path. `POST /api/notifications/dispatch`
now sends **push first, then WhatsApp** — push arrives in about a second and
costs nothing, so WhatsApp only earns its keep when the student has no
subscription.

Turn it on from Settings. The browser hands back a subscription that is stored
in `push_subscriptions`; `public/sw.js` handles `push` and `notificationclick`
and deliberately caches nothing, so there's no stale-shell class of bug. A
subscription that returns 404 or 410 is deleted rather than retried forever —
those two codes mean the browser has permanently dropped it.

It needs a VAPID keypair in `.env.local`:

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:you@example.com
```

Generate one locally with `npx web-push generate-vapid-keys`. The keys identify
your server to the push service; nothing external issues them and no account is
involved.

### How the operator opens a file

This was broken until `0011`: storage policies let a student read their own
uploads and nobody else, so the operator literally could not open the document
they were meant to print.

`claim_document_access(p_item, p_purpose)` is a security-definer RPC that checks
the caller is staff for **that** order, writes a row into `document_access_log`,
and returns the storage path. `lib/operator.ts` then signs a short-lived URL for
it. Two consequences worth keeping: every open is logged against a named person,
and access ends when the order does — the storage policy only matches orders
still in `placed`…`ready`.

### Files don't live forever

Six hours after an order is collected, a trigger stamps `purge_at` on its
documents. `POST /api/maintenance/purge` then deletes them — **storage objects
first, then the rows**. That order is deliberate: a deleted row with a surviving
object is an orphan nothing will ever clean up, whereas a surviving row with no
object is self-healing on the next run.

Point a scheduler at it with the same `x-notify-secret` header the dispatch
route uses. `GET` on the same path reports how many are due.

### Settings belong to the file, not the order

Until `0013` one config covered the whole job, so a colour cover with a
black-and-white body — the most ordinary print job on a campus — was two
orders, two tokens and two payments. `order_items.config` now holds each file's
own settings, and `order_items.price` finally means something because binding
and copies are per file too.

The bulk slab and the minimum order stay properties of the *job*: printing 60
pages and 60 more is a 120-page job, and charging each half at the small-job
rate would be wrong. `quoteOrder()` in [`lib/pricing.ts`](lib/pricing.ts) is
where that split lives, and `npm run check:pricing` asserts both halves.

The chips are priced from the same function. Each one shows what picking it
would do to the total — "double-sided −₹24", "staple +₹5" — recomputed by
re-running `quoteOrder` with that one option swapped, so the number on the chip
is exactly the number the footer will show. A chip you are already on shows the
rate instead, where it explains the price rather than a change to it.

The operator's card lists each file's settings separately and says **settings
differ per file** in place of the order-level summary when they disagree, since
printing that job to one setting is now a real mistake to make.

### Reporting a bad print

The refund control shipped first on purpose — a complaint that lands nowhere is
worse than no button at all. A student can report a job once it is `ready`,
`collected` or `failed`; the report appears on the operator's card over
realtime, and the operator closes it with what they did about it.

Deliberately separate from the refund: reporting decides nothing, and the sheet
says so rather than promising money back that only the operator can send. One
open report per order, enforced by a partial unique index, so a frustrated
student refreshing the button doesn't file ten.

### The database prices the order — to the paisa

Since `0014`, the browser never writes a total. `place_order()` takes the files
and their settings, prices them from the operator's rate card with the same
arithmetic as `lib/pricing.ts`, and inserts the order and its items in one
transaction. The quote in the sheet is a preview of what the database will
decide; `npm run check:sql` proves the two agree across 144 jobs — every
total *and every line price*, to the paisa.

Since `0017`, amounts are exact. An operator who sets ₹1.50 a page means ₹4.50
for three pages, and that is what is charged and shown; the earlier engine
rounded the order to a whole rupee. Each file's price is round-half-up to two
decimals, the total is the sum of those prices so a bill always adds up, and
the minimum order is an explicit *small-order top-up* line. Getting Postgres
to round exactly as the browser does took care: its `float8 → numeric` cast
rounds to fifteen significant digits first, and its `round(float8)` is
banker's rounding, so `to_paise()` spells out the browser's rule instead.

Every order also carries `rate_card` — a snapshot of the operator's rates at
the moment of pricing. The bill on `/orders` is rebuilt from that and the
items, so it stays what the student was actually charged after the desk
changes its prices. Orders older than the snapshot are shown at today's
rates and labelled as an estimate, with the stored total the number that
counts.

This closed the most serious finding of the security pass, and
[`docs/SECURITY.md`](docs/SECURITY.md) has the rest: what each boundary is
enforced by, what was found, what was fixed, and what is still open. Read it
before changing a policy.

### The desk's own tools

`0015` and `components/operator/` add what a counter uses between orders:

- **Scan to hand over** — the browser's `BarcodeDetector` reads the student's
  QR (or the printed slip's); where a browser lacks it, the same sheet is a
  token field. A scan only *finds* the order. Handing it over is still a tap,
  because a scan of the wrong phone must never be a completed handover.
- **Message the student** — one direction, desk → student, with a push behind
  it. "Page 3 is blank — print it anyway?" lands on their status capsule while
  they're still looking at it. Read receipts come back over realtime.
- **Close out** — expected cash from today's cash orders, what's in the drawer,
  the difference shown rather than hidden, UPI to reconcile against their own
  app, a nudge for everything still on the shelf, then *Close the desk*. One
  row per day.
- **Staff** — *Add someone* makes a join code; they open it on their own
  phone, sign in once, and they're on the list with the name from their
  account. The last person can't remove themselves. *Handled by* on finished
  cards puts a name to `order_events.actor`, which has always been recorded.
- **Stock as a ledger** — every change is a row with a reason and a person;
  collected jobs write their own. A number you overwrite is a number nobody
  trusts by Wednesday.
- **Job slip** — token, name, files with their settings, a QR. Prints on its
  own through a print stylesheet that hides the rest of the page.
- **Next up**, **age badges** (amber past what the rate card promised), the
  **Scheduled** tab grouped by hour with *due in 20 min*.

### The platform fee — how Printify earns

Every order carries a **platform fee**: a percentage of the order after the
desk's minimum (3% by default, set in `/admin`, with an optional floor per
order), shown as its own line on the student's bill and paid in the same
UPI tap or cash as the rest. Money never passes through Printify — the desk
collects the fee with the order and **settles it to Printify's VPA**, which
the desk's Takings page shows with a QR for the outstanding amount. The
admin records each payment received; owed minus settled is the balance.

```
essay.pdf   7 p B&W            ₹10.50
Platform fee (3%)               ₹0.32
Total                          ₹10.82
```

The arithmetic is `place_order()`'s, in double precision in the same order
as `quoteOrder()` — base × percent ÷ 100 to the paisa, then the floor — and
the percentage is snapshotted into `rate_card`, so an order keeps the rate
it was priced at when the admin changes it. The guard pins `platform_fee`
like every other priced column. Fees are **owed on collected orders that
weren't fully refunded**; a cancelled or fully refunded order carries none.

Where it shows: the student's bill (print sheet, orders page, island); the
desk's order card (*incl. ₹0.32 Printify fee*); **Takings** (*Printify fee
(to settle)* and *Yours after the fee*, plus a *Printify fee* panel with
today / this week / this month, the all-time balance, the QR and payments
recorded); and **`/admin`** (the rate and payee VPA, orders and fee earned
today / this week / this month across every desk, each desk's outstanding
balance, and *Record payment*). Calendar windows, in the viewer's own time.

`supabase/reset.sql` deliberately keeps `platform_settings` — the rate and
the VPA are configuration, not data — and the harness knows it does.

### The fee has a due date

`0025`: fees on a month's orders are due when the month ends. The admin
sets a grace period (fifteen days by default); once it's past, a desk with
anything unsettled from earlier months **can't flip to Open** until it
settles — a trigger on `operators` refuses the switch with the amount and
the month in the sentence, and the Takings panel says *Due … settle by …*
before that and *Overdue* after. Closing is always allowed, and a desk that
is already open stays open; the lock catches the next morning.

Also in `0025`: every push subscription records the VAPID public key it
was made with, and the dispatcher names a mismatch ("subscribed with a
different VAPID key") instead of retrying a push the service will refuse.

### The capsule paints after one round trip

Every hop from a phone in India to the database costs what the database's
distance costs — half a second, measured, while the project sits in Tokyo.
So the number of hops is what the code controls:

- `activeOrderBundle()` fetches the live order **with its timeline
  embedded** (PostgREST follows `order_events.order_id`), and
  `queue_status_mine()` (`0029`) finds the caller's newest live order by
  itself — so the capsule asks for both **at once**. It used to ask for the
  order, wait, then ask for the timeline and the queue: two trips in
  sequence, now one.
- `getOperator()` caches each desk's row for thirty seconds and the capsule
  warms it as soon as it has an order, so *Pay now* opens with the id and
  the QR already there instead of fetching the desk first. The desk's own
  writes drop the cache; the header's realtime reload bypasses it.
- A status change still arrives over the socket and is painted from the
  payload before anything is refetched.
- `vercel.json` pins the functions to **`bom1`** (Mumbai). Without it Vercel
  runs them in `iad1` (Washington), which put every server-rendered page
  a quarter of the way round the world from the people loading it.

The database's own region is the remaining lever, and it's yours — see
*Marked for you*.

### The shelf, the board, the badges, the buzz

Four small things (`0030`), each one a fact the app already had, put
where it's needed:

- **A slot on the shelf.** A desk that sets *Shelf and board → rows ×
  slots* (A–H × 1–20) gets every job a slot the moment it's marked ready:
  the lowest one no *ready* job at that desk holds, assigned by a trigger
  after the guard and the event recorder (`orders_shelf_slot`; triggers on
  one event fire in name order). It's on the slip under the token, on the
  card as *Shelf B3* (tap to move it; a full shelf shows *no slot* to
  fill in by hand), on the handover panel, on the student's capsule and
  order card, and on the board. It frees itself: the in-use set is "ready
  jobs' slots", so collection, cancellation and failure all release it
  without a write. The guard pins `shelf_slot` against the student.
- **The board.** `/board?desk=<id>` — tokens *ready to collect* (with the
  slot), *printing* and *in line*, in type readable from the door. No
  names, no files: `board()` is security-definer and open to anon, since a
  token is already on every slip on the shelf. It polls every five seconds
  (a TV isn't signed in and realtime respects RLS) and rides the socket
  too when the desk's own account is on it; a shut desk shows nothing.
  *Shelf and board* in the desk's settings has the link and a copy
  button. On both hosts.
- **Cheapest / fastest on the desk picker.** Each listed desk is priced
  for the job in the upload sheet (or, with nothing staged, ten pages
  black & white — the note says which) with `quoteOrder()` and asked its
  wait with `operator_wait()`, all at once. The strictly cheapest open
  desk and the strictly quickest get a badge; ties earn nobody one, a
  closed desk can't win, and one desk alone gets no badge at all.
  `pickBadges()` is pure and checked.
- **The buzz.** When the socket paints a new status, `navigator.vibrate`
  — a tap for most moves, a longer pattern for *ready*, a single long one
  for cancelled or failed — only when the page is visible and the browser
  has the API. When the tab isn't open, the push notification carries the
  same pattern, chosen by the dispatcher from the body 0006's trigger
  wrote.

### Installing it as an app

The site installs to the home screen on the student's say-so, not the
browser's. Chrome (Android, desktop, Edge, Samsung) fires
`beforeinstallprompt` once the manifest, icons and service worker qualify,
and left alone it shows its own "Add to Home screen" bar whenever it likes
— that was the random prompt. A one-line inline script in the root layout
now catches the event first, `preventDefault()`s it and parks it on
`window`; `lib/install.ts` picks it up. From then on there is an **Install**
pill in the header and an *Install the app* row on the profile, and both
open one sheet (`components/install-app.tsx`) that does the right thing for
the browser at hand:

- **Chrome's prompt in hand:** an *Install* button that fires the browser's
  own dialog. Accepted, the sheet says you're set and the pill goes.
- **iPhone / iPad:** Safari has no dialog, so the three Share-sheet steps.
  iPadOS calls itself a Mac; a touch screen tells them apart.
- **Turned the dialog down:** Chrome hands out one event per page load, so
  the tap then shows the menu route instead of doing nothing.
- **Already installed, or a browser that can't** (desktop Firefox, desktop
  Safari): nothing is drawn. The site never nags.

The layout also sends `apple-touch-icon`; without it iOS puts a screenshot
of the page on the home screen instead of the icon. `platformFrom()` and
`canInstall()` are pure and checked in `check:features`.

### The admin can shut a desk

`0026`: the one lever the admin has over a running desk, whatever state
it's in. *Shut this desk* on `/admin/desks` asks for a reason — required,
kept with the desk, shown to its staff — and then, in one transaction:
unlists it, closes it, revokes its open join codes, and pins it there.
Triggers refuse the desk's own staff at every door: they can't open it,
list it, add anyone or make a code, by the app or by a direct update.
Students can't see it or place an order at it.

What's already in the queue stays the desk's to finish: a student who has
paid can still collect or be refunded, and the fee on those orders is still
settled from Takings. The desk site shows a banner with the date and the
reason on every page. *Restore* reverses it — listed again, closed, for its
own staff to open. `admin_desks()` carries `shut_at`, `shut_reason` and
`live_orders` so the confirmation says what the desk is left holding.

### Sending happens when something is queued, not on a timer

`POST /api/notifications/poke` drains the queue for any signed-in caller —
it can't choose what's sent, only that the queue is drained, and every row
is claimed atomically, so a stampede of pokes sends nothing twice. The app
calls it after the three things that queue a notification: a student
placing an order (the desk's push), a desk moving an order along (the
student's push), and a desk messaging a student. The scheduled
`dispatch?run=1` stays as a daily backstop — the only cadence Vercel's
Hobby plan allows, and enough for anything queued by hand.

### The desk hears about new orders

`0021`: a device that turns on *New-order alerts* in the desk's settings gets
a push the moment an order is inserted — "New order A03 — 7 pages, 2 colour,
₹22.25" — with the tab closed or the app in a pocket. The subscription row is
flagged `desk`, so the dispatcher sends desk rows only to desk devices and a
student's "ready" pushes go where they always went. Staff with no desk
device get no row at all rather than a "skipped" line per order. The same
queue, the same dispatcher, the same honesty about what was sent.

### Starting a shift without Google

A counter's tablet changes hands three times a day, and a Google sign-in each
time is the wrong shape for that. `0018` adds **desk sign-in**:

1. Someone on staff signs in through Google once, opens *Settings → Desk
   sign-in*, sets a PIN (four to six digits), and taps *Pair this device*.
2. From then on, when that device is opened with nobody signed in, it shows
   the desk's staff as tiles. Tap your name, type your PIN, you're in.
3. *Switch staff* in the header signs out and returns to the tiles.

Under the hood, the PIN check happens in Postgres (`desk_verify_pin`), and on
success `/api/desk` asks Clerk for a sixty-second sign-in token for that user.
The browser turns it into an ordinary Clerk session — so RLS, the write guard
and `is_staff` see nothing different from a Google sign-in. Five wrong tries
lock a PIN for five minutes. A lost device is revoked from the same panel.

Two settings in the Clerk dashboard make it comfortable: **Sessions →
Inactivity timeout** off (or long), and **Maximum lifetime** around 30 days,
so a paired desk stays signed in between shifts rather than asking for a PIN
every morning. Passkeys (Clerk → User & Authentication → Passkeys) are a
nice second option for staff on their own phones.

### Refunds are recorded, not sent

The operator's refund control writes `refunded_at`, `refund_amount` and
`refund_note`, shows the student a line on their order, and subtracts from the
day's takings. **It does not move money** — no gateway, no merchant account, so
the operator sends it from their own UPI app or the cash drawer. The panel says
so in as many words, because an operator who believes the button paid the
student will not pay them.

### Limits that live in the database

The UI is not the only way to reach the API, so the ceilings are triggers:

- **60 uploads an hour** per account, and **500 MB** of live documents at once
  (`enforce_upload_limits`, `0012`).
- **Students can't write operator columns.** `guard_order_update()` pins every
  column a student may not change, by name. RLS grants a *row*, never a
  *column* — without the trigger, a student could `PATCH` their own pending
  order's `total` to 1. `npm run check` asserts each pinned column is still
  listed, because this has been got wrong twice: once for `total`, once for the
  refund columns `0011` added after the guard was written.

### Payment is deliberately not faked

No gateway is wired up, so the app doesn't pretend to take money. The pay sheet
builds a `upi://pay` deep link straight to the operator's own VPA, with a QR of
the same link for laptops. The money never touches this app.

That means nothing here can *know* a transfer succeeded. So the two facts are
kept apart: `payment_claimed_at` is the student saying they paid, and
`payment_taken_at` is the operator confirming they saw it. Only the second one
moves the order. The student can add their UPI reference number, which turns the
operator's check from a guess into a lookup in their own statement — and once
the operator has confirmed, the guard trigger freezes that reference, since it's
evidence by then.

`quote()` is pure, so a gateway can re-run it server-side later to authorise a
real charge.

**Two kinds of UPI id** (`0027`). The apps refuse a link or QR that a
website generated *with the amount filled in* when the payee is an ordinary
personal id — PhonePe says "Transaction not allowed", GPay "restricted by
the bank" — and accept it for a merchant id, the one behind a shop's
PhonePe Business / Paytm for Business / GPay Business QR. So a desk says
which it has (`operators.upi_kind`, personal by default), and the pay
sheet does what works for that kind: a merchant id gets the one-tap link
with the amount and the shop's merchant code (`upi_mc`); a personal id
gets *Copy UPI id · Copy amount* and two steps, with the link kept as
"try anyway". The desk can **read its own QR from a photo** under
Getting paid — `parseUpiQr()` takes the id, the name and the merchant
code off it, and `mc` present and not `0000` is what decides the kind.
Printify's own settle-up id follows the same rule (`payee_kind`, set on
the Fees page).

The link to a merchant id carries `pa`, `pn`, `am`, `cu`, `tn`, `tr` and
nothing else — no `mc`, `mode`, `orgid` or `sign`. Those mark a link as
a *merchant-generated* intent, and the apps then hold it to the merchant
rules, above all a signature from the merchant's own PSP, which a link a
website built can't carry; PhonePe answers "our banking partner is unable
to process your request". Whether the payee is a merchant is a fact of
the id, known to the PSP, and a plain link goes through on that alone.
The merchant code read off the QR is kept on the row for the record, not
sent. `tr` is alphanumeric and padded (`PRINTIFYB66…`) because the strict
apps refuse punctuation and very short references; `tn` is letters,
digits and spaces.

The id field takes what people actually paste. `normaliseVpa()` strips
whitespace and the invisible characters a copy from WhatsApp or a business
app drags along (zero-width spaces, a BOM, soft hyphens), and a whole
`upi://pay?…` text — some phones copy the QR's contents — yields its `pa`.
The hint says *Will be saved as …* when that changed anything, and when an
id is refused `vpaProblem()` says why in words ("Can't contain "#" before
the @"), never a bare "invalid". Merchant ids as the apps issue them —
`Q123456789@ybl`, `paytmqr…@paytm`, `gpay-…@okbizaxis`,
`BHARATPE…@yesbankltd` — are all accepted and checked. A bank's Bharat QR
(EMVCo tag-length-value, not a `upi://` link) is read too: the id from a
merchant-account tag, the category code from tag 52.

`OPERATOR_SELECT` can name a column the live project hasn't got yet if a
deploy lands before its migration; the operator queries retry once with
the previous column list on `42703`, so a desk never disappears for that.

**The amount is a fact the desk records** (`0028`). With a personal id
the student types the amount, so three things keep that honest:

1. **Round to the rupee** — a desk setting under *Getting paid*. The
   total is lifted to the next whole rupee, *after* the fee, shown on the
   bill as "Rounded to the rupee +₹0.03" (`orders.rounding`). Priced in
   `place_order` exactly as `roundedTotal()` prices it in the browser; the
   lines and the fee don't move. ₹14 is typed right far more often than
   ₹13.91.
2. **Amount received** — on a UPI claim, *Confirm payment* opens a row
   with the bill pre-filled; the desk types what its own app shows
   arrived (`orders.payment_received`; a bare confirm records the bill).
   Short: the card and the handover panel say *collect ₹0.72 cash* until
   the desk taps *Took ₹0.72 cash* (`shortfall_cleared_at`). Over: the
   refund form opens pre-filled with the difference. The student's order
   shows the same line. The Next-up bar routes a UPI claim at a
   personal-id desk to that row rather than accepting blind.
3. **Amount you sent** — the student's claim, entered with the reference
   when they tap *I've paid by UPI* (`orders.payment_claimed_amount`). A
   number that isn't the bill is a warning on the phone — "₹0.72 short;
   the desk will take the rest at pickup" — not a surprise at the counter.
   The desk sees the claim beside its own field. Like the reference, it's
   theirs to write until the desk confirms and frozen after.

The guard pins `rounding`, `payment_received` and `shortfall_cleared_at`
against the student; `check:features` asserts it, and the harness runs a
rounding parity grid and the whole claim/confirm/clear sequence.

## How a file becomes a price

`hooks/use-uploader.ts` runs analysis *before* upload, so the quote appears
without a round trip and a failed upload degrades to local-only rather than
losing the file.

```
drop / pick → validate → analyse → Clerk session → upload (XHR, real
              progress) → row in `documents` → quote
```

**Colour detection reads the operator list, not pixels.** `page.getOperatorList()`
exposes every fill and stroke pdf.js has normalised to RGB, so a coloured chart
or heading is visible without rasterising. It's far faster, needs no canvas, and
— unlike `page.render()` — doesn't depend on `requestAnimationFrame`, which a
background tab suspends. Only pages that paint a raster image fall back to
rendering, since their colours aren't in the operator list.

## Layout

```
app/
  layout.tsx          fonts, metadata, theme provider, <AppChrome>
  page.tsx            home — upload, files, live status, totals
  orders/page.tsx     your orders, live
  operator/page.tsx   Printify Operator — the live print queue
  profile/page.tsx    totals, stored documents, connection status
  settings/page.tsx   appearance, account, privacy
components/
  status-island.tsx   live job capsule, driven entirely by order rows
  operator-board.tsx  the only thing that advances an order
  order-list.tsx      your orders, with cancel while still cancellable
  print-sheet.tsx     upload step → options step → place order
  upload-step.tsx     dropzone, per-file progress
  feed.tsx            your stored documents
  widgets-row.tsx     real totals from my_totals()
  search-dialog.tsx   ⌘K over your documents and orders
hooks/
  use-tracking.ts     realtime subscriptions + queue reads
  use-uploader.ts     validate → analyse → upload → record
lib/
  orders.ts           order reads/writes and the status machine
  analysis.ts         page count + per-page colour
  pricing.ts          pure quote engine — same code client and server
  supabase/client.ts  browser client, tokens bridged from Clerk
supabase/migrations/  schema, RLS, triggers, queue functions
```

## Traps worth knowing about

Each of these cost real debugging time. All are commented at the call site.

**Never park content at `opacity: 0` waiting on an animation.** `gsap.from()` and
motion's `initial={{ opacity: 0 }}` both do this, and rAF stalls whenever the tab
isn't painting — a page opened in a background tab then stays blank until it's
focused. `stagger-in.tsx` guards on `document.visibilityState`, and list items
have no per-item entrance at all.

**`-z-10` on a sliding pill disappears behind its own container.** The active-tab
indicators use `layoutId` with `absolute inset-0` and the *label* in a `relative`
span — not a negative z-index. Any parent with a background paints over it.

**A single-column grid track is `min-content`, not `1fr`.** Pages declare
`grid-cols-[minmax(0,1fr)]` explicitly. Without it the `truncate` on the status
capsule's subtitle sets a wide minimum and pushes the page wider than a phone.

**pdf.js 6 ships an ES-module worker.** Setting `workerSrc` to a string lets
pdf.js build a *classic* `Worker`, which fails to parse the module and then hangs
`getDocument` forever with no error. The worker is constructed with
`type: "module"`.

**pdf.js 6 reports colours as CSS hex strings** (`"#d93326"`), older builds as
`[r, g, b]` in 0–255 or 0–1. `isColoured()` accepts all three, so an upgrade
can't silently turn every page monochrome.

## Not built yet

Kept honest deliberately — anything listed here has no UI pretending otherwise.

- **Payment gateway.** Deliberate — see above.
- **Server-side conversion.** Word and PowerPoint page counts are estimated from
  file size and shown with a visible `≈`; they need Gotenberg to be exact. Page
  review previews PDFs for the same reason.
- **Phone OTP.** Clerk is set up with email and Google; SMS sign-in isn't
  enabled yet.
- **Resumable uploads.** A dropped connection at 90% starts again. Supabase
  supports TUS; the uploader doesn't use it yet.
- **Batch printing.** The operator opens files order by order rather than
  merging a shift's mono jobs into one spool.
- **Reorder and camera scan.** Both are real gaps in the student flow, neither
  is stubbed.
- **Recovery when an order is declined.** The capsule now offers *Try again*,
  which reopens the sheet — but not one tap to re-place the identical job with
  another operator, which is what it should eventually do.
- **Error monitoring and analytics.** Nothing reports a client-side exception
  home, so a broken upload is invisible until somebody says so.
- **Shared notes library and campus templates.** Both were removed rather than
  shipped with invented content.

## Marked for you

Things the code can't do on its own, in the order they bite:

1. **Supabase Pro (or keep it busy).** A free project pauses after about a
   week idle, and a paused project is the whole app gone. Nothing in the
   code protects against this.
2. **Run 0022 → 0030** in the SQL editor, pasted from the files. Until
   0025, the fee panel shows no due date; until 0024, the join page shows a
   migration message in the application panel; until 0026, *Shut this
   desk* on `/admin/desks` errors with a missing function; until 0027,
   every desk pays as a personal id and saving *Business QR id* fails;
   until 0028, no bill rounds and the confirm row's amount is not kept;
   until 0029, the capsule's queue position errors quietly and shows no
   place in the queue; until 0030, the board says "reconnecting…", no
   slot is assigned, and saving the shelf fails.
3. **Move the database nearer.** The Supabase project resolves to Tokyo
   (`ap-northeast-1`); from India every query is ~500 ms and the capsule,
   the pay sheet and the desk's queue all feel it. Supabase can't move a
   project, so: create a new project in **Mumbai (`ap-south-1`)**, run
   `0001 → 0029` in its SQL editor, create the private `documents` bucket,
   add both Clerk domains under Authentication → Third-Party Auth, then
   swap `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   and `SUPABASE_SERVICE_ROLE_KEY` on both Vercel projects and in
   `.env.local`, redeploy, and run `check:rls` against it. Nothing in the
   old project is worth carrying over before launch. Confirm the region
   first under Project Settings → General.
4. **`npm run check:rls` with two ordinary accounts** — a student who is
   *not* the admin and a desk account that *is* on a desk, both signed in
   recently. The run so far (anonymous + the admin account) passed 21 probes;
   the four admin-only refusals need a non-admin account to mean anything.
5. **One VAPID pair.** Both Vercel projects get the same
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, and both need
   `SUPABASE_SERVICE_ROLE_KEY` and `NOTIFY_WEBHOOK_SECRET`, because either
   site may be the one that sends: the app **pokes the dispatcher itself**
   the moment it queues something (an order placed, a status moved, a
   message sent), so pushes go out in seconds with no scheduler. The
   `vercel.json` crons are daily backstops, which is all the Hobby plan
   allows; they run on whichever project keeps the file — both is harmless.
   `/diagnostics` shows the key's last twelve characters on each site so
   you can compare.
6. **Both Clerk domains in Supabase → Third-Party Auth**, and both apps on
   production instances before launch (dev instances are capped).
7. **All three host variables on both projects** — `/diagnostics` flags a
   pinned desk with no student host.
8. **Page counts are client-reported.** A claimed page count prices the
   order; the operator opens the file before printing, which is where a
   wrong one is caught. Server-side counting needs a server that opens
   PDFs — not built.

## Verification status

Being specific about this matters more than a green badge:

- `npm run check` — types, pricing (168 jobs with a 3.25% fee: whole paise,
  lines + top-up + fee = total, the fee is the percentage of what sits under
  it), phone normalisation, pickup slots, UPI link format, the write-guard
  column list, the two-site routing table, the fee's calendar windows, and
  the SQL below. **Passes.**
- `npm run build` — **passes.**
- `npm run check:sql` — all twenty-five migrations applied, re-applied, and their
  triggers driven through a real order under a real JWT: tokens, the timeline,
  the write guard, per-file settings, the report constraint, the upload
  ceiling, the order rate limit, document ownership, push endpoint sanity, and
  SQL-vs-TypeScript pricing across 144 jobs, messages queuing a push, the
  stock ledger, staff by email, closing the desk, a hundred concurrent tokens
  at one desk, the handover code, desk sign-in end to end (pairing, PIN
  rules, lockout, revocation), and join codes (admin creates a desk, a code
  joins once, expired and revoked codes are dead, twenty guesses and you
  wait, applications gone, the admin is shut out of a staffed desk, no
  function or policy can write `admins`, a new order pushes to desk devices
  and only them, the platform fee — the 144-job parity grid now runs at
  3.25%, the fee on the lifted minimum, the floor, the guard, and the
  ledger with a settlement and a fully refunded order excluded, and
  applications — one pending per person, admin-only approval that makes the
  desk and a code bound to the applicant, another account refused, rejection
  needs a reason, withdrawal, and the fee lock — overdue refuses Open,
  within grace allows it, settling unlocks). **Passes.**
- `npm run check:rls` — the policies against the **real project**, as real
  roles: anonymous reads nothing from seven tables and can read the fee
  rate; a signed-in account sees only its own orders, documents, staff row
  and profile, nothing from the desk-only tables, can't insert a settlement
  or a staff row, can't rewrite its total. **21 probes pass** on the live
  project; the four admin-only refusals are skipped until a non-admin
  account runs it. It does not check the RLS policies
  themselves; see above for why.
- **Two sites** — the routing table is unit-tested row by row (38 checks),
  and a split-mode production server was probed on both hosts: every student
  page serves on the student host, every desk page on the desk host, every
  stray page hops across with its path and query intact, and neither site's
  HTML links to the other. Both doors render; a wrong password shows Clerk's
  own "Couldn't find your account."; account creation reaches Clerk's bot
  check inside the page. Completing a Google or password sign-in needs a
  real account, which is a you-step.
- **Desk sign-in** — `/api/desk` verified against the live project: a malformed
  body gets 400, an unknown device gets 401 with the database's own message.
  The tile screen and its revoked-device state render; a real PIN sign-in
  needs a paired device and a Clerk secret key, which is a you-step.
- **Scan to hand over** — decoding is jsQR wherever the browser's own
  `BarcodeDetector` can't actually read QR codes (Windows Chrome has the
  constructor and none of the formats). `npm run check:features` rasterises the
  island's exact payload with `qrcode` and reads it back with jsQR, inverted
  too. The live camera itself needs a secure context — `localhost` or
  `https`; over plain `http` on a LAN the sheet says so and offers a photo
  through the native camera instead, decoded the same way.
- **Strict CSP** — verified in the browser: Clerk, its sign-in modal, the
  pdf.js worker, blob thumbnails and the QR all load with zero violations.
- `npm run check:migrations` — the Docker version. **Still never executed**,
  because Docker Desktop wouldn't start here. `check:sql` covers the same
  ground without it.
- **WhatsApp delivery** — code path complete, no message ever sent from here.
  Needs a Business number.
- **Web push** — keys generated and the round trip is wired, but it only works
  over HTTPS or `localhost`, so it's untested on a LAN address.
