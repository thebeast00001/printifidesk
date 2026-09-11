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
then [`0017_paise_and_rate_snapshot.sql`](supabase/migrations/0017_paise_and_rate_snapshot.sql).

These are **SQL** — they go in the Supabase dashboard's SQL editor
(`Project → SQL Editor → New query`), not a terminal.

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

**4. Make yourself an admin.** Sign in, open **`/diagnostics`**, and press
**Make me an admin**. The button only appears while nobody holds it, and the
database refuses a second claim — so it can't be used to escalate later.

On a deployment left public with no admin, the first stranger to sign in could
claim it, so do this immediately after migrating. To take the seat manually
instead:

```sql
insert into public.admins (user_id) values ('user_...');
```

Everyone after you applies at `/operator` and is approved by you at `/admin`.

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

### Becoming an operator

`/operator` shows one of three things: a sign-in prompt, an **application form**,
or the portal. Applying is a real form — display name, campus, location, phone,
machine — reviewed at `/admin`. Approval calls `approve_application()`, which
creates the `operators` row and the `staff` row **in one transaction**, so a
half-approved application can't exist. Only admins can call it, enforced inside
the function rather than in the UI.

New operators start **closed and unlisted-to-nobody** (`is_open = false`), so
nothing goes live until the person opens their own desk.

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
- **Staff** — add a colleague by their sign-in email; the last person can't
  remove themselves. *Handled by* on finished cards puts a name to
  `order_events.actor`, which has always been recorded.
- **Stock as a ledger** — every change is a row with a reason and a person;
  collected jobs write their own. A number you overwrite is a number nobody
  trusts by Wednesday.
- **Job slip** — token, name, files with their settings, a QR. Prints on its
  own through a print stylesheet that hides the rest of the page.
- **Next up**, **age badges** (amber past what the rate card promised), the
  **Scheduled** tab grouped by hour with *due in 20 min*.

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

## Verification status

Being specific about this matters more than a green badge:

- `npm run check` — types, pricing, phone normalisation, pickup slots, UPI link
  format, the write-guard column list, and the SQL below. **Passes.**
- `npm run build` — **passes.**
- `npm run check:sql` — all seventeen migrations applied, re-applied, and their
  triggers driven through a real order under a real JWT: tokens, the timeline,
  the write guard, per-file settings, the report constraint, the upload
  ceiling, the order rate limit, document ownership, push endpoint sanity, and
  SQL-vs-TypeScript pricing across 144 jobs, messages queuing a push, the
  stock ledger, staff by email, and closing the desk. **Passes.** It does not
  check the RLS policies themselves; see above for why.
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
