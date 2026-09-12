# Security

What protects what, what was found in the September 2026 pass, and what is
still open. Written so the next person can tell the difference between a
control that is enforced and one that is merely intended.

## The shape of the system

There is almost no server. The browser talks to Supabase directly with a Clerk
JWT, and Postgres row-level security decides what each request may see or
change. Two Next.js routes exist for jobs a browser can't do — sending
notifications and purging files — and they authenticate with a shared secret,
not a user.

That shape has one consequence worth stating plainly: **the RLS policies and
the database triggers are the security model.** The React code is a
convenience. Anything the UI prevents, a student with `curl` and their own
token can still attempt, so every rule that matters has to hold in Postgres.

## Trust boundaries

| Boundary | Enforced by | Notes |
|---|---|---|
| Who you are | Clerk JWT → `public.clerk_id()` reads `sub` | Supabase verifies the signature; nothing here does. |
| Your rows vs mine | RLS on every table | `user_id = clerk_id()` or `is_staff(operator_id)`. |
| Staff vs student | `public.staff` table, read by `is_staff()` | Written only by `claim_invite()` (a live join code), `add_staff()` (staff, by email) or manual SQL. Desks are created by `create_operator()` (admin). |
| Admin | `public.admins`, read by `is_admin()` | **No write path from the app at all** (0020): no function inserts, no policy allows it. Granted only by SQL in the project dashboard. An admin creates desks and mints a code for an *empty* desk; nothing else. |
| Order price | `place_order()` RPC (0014) | The browser never writes a total. See below. |
| Platform fee (0022) | Computed in `place_order()` from `platform_settings`, snapshotted, pinned by the guard | The rate is admin-only (`set_platform_fee`). The ledger (`fee_window`, `fee_balance`, `admin_fee_desks`) is derived from orders, never typed; settlements are recorded by the admin only. |
| Order changes | `guard_order_update()` trigger (0009, 0012) | Pins every column a student may not touch, by name. |
| Files | Storage RLS keyed on the path's first folder | Path is `<clerk id>/<doc id>-<name>`; `documents_path_owned` (0014) ties the row to it. |
| Operator file access | `claim_document_access()` RPC + storage policy (0011) | Logged per open; only while the order is live. |
| Handover | `handover_code` in the student's QR (0016) | Per-order secret; the slip's QR has none. Scanner reports verified / found / wrong. |
| Desk sign-in (0018) | `desk_devices` (hashed token) + `staff_pins` (salted hash, lockout) → `/api/desk` → Clerk sign-in token | A name-and-PIN shift start on a paired device. The result is an ordinary Clerk session; nothing downstream changes. See below. |
| Maintenance routes | `NOTIFY_WEBHOOK_SECRET`, compared in constant time | Clerk middleware skips `/api/`; the secret is the whole gate. |
| Desk tools (0015) | RPCs check `is_staff` themselves; tables have read policies only | Messages: staff insert, owner reads. Stock and close-outs: no client insert path at all. Staff: `add_staff` looks up by email, `remove_staff` refuses to empty the desk. |
| Two sites | `lib/surface.ts` in the middleware, keyed on the request host | The desk's pages never serve on the student host and vice versa; the door on each shows only its own sign-in method. Not a security boundary on its own — RLS is — but it keeps a student from ever seeing a desk page, signed in or not. |
| Browser | Strict nonce-based CSP + the headers in `next.config.ts` | Injected script runs nothing, even where escaping fails. |

## Findings from the pass

Ordered by what it would have cost.

### 1. The order total was whatever the browser said — **fixed, 0014**

`orders insert` checked `user_id = clerk_id()` and nothing else. `total`,
`pages`, `colour_pages` and every per-file `price` came from the client. The
guard trigger stopped a total being *changed* after the fact; nothing stopped
it being wrong from the start. A student could place a ₹1 order for three
hundred colour pages, and the only defence was the operator noticing before
accepting.

Now `place_order(p_operator, p_items, p_pickup_at)` is the only way an order is
created. It reads the operator's rate card, prices every line with
`price_line()` — a port of `lineCost()` from `lib/pricing.ts` that does its
arithmetic in `double precision` so it rounds where the browser rounds — and
writes the order and its items in one transaction. The two direct insert
policies are gone.

**Verified:** `npm run check:sql` places 144 jobs across a grid of page counts,
colour modes, sides, bindings and copies, and asserts the SQL total equals the
TypeScript total for each. All 144 match.

**What it still trusts:** the page count and colour-page count. Those come from
the file, and the server never opens the file. A claimed "10 pages" on a
300-page PDF is priced as 10 pages — and shown as 10 pages on the operator's
card, next to a file they open before printing. That is where it gets caught,
and the model says so rather than pretending otherwise.

### 2. A student could hand the operator someone else's file — **fixed, 0014**

Two routes to the same disclosure:

- `order_items.document_id` was unchecked. Attach a document id you don't own,
  and the staff policies from 0011 grant the operator that row *and its object*.
- `documents.storage_path` was unchecked. Insert a row with your `user_id` and
  somebody else's path, and the same policies do the same thing.

Document ids and user ids are visible to any operator who has served either
party, and anyone can apply to be an operator. So a staff member who is also a
student could have opened any file they had ever seen an id for, after the
order that legitimately exposed it had closed.

`place_order()` now refuses a `document_id` the caller doesn't own, and the
`documents_path_owned` constraint requires `storage_path` to begin with
`user_id || '/'`. The constraint uses `left()`, not `LIKE`: Clerk ids contain
underscores, and `_` is a `LIKE` wildcard.

### 3. No Content-Security-Policy, no security headers — **fixed**

Every free-text field — filenames, notes, reports, references — is rendered
through React, which escapes it. That is one layer. Before this pass it was the
only one.

`proxy.ts` now sets a strict, nonce-based CSP through Clerk's middleware:
`'strict-dynamic'` with a per-request nonce, so only scripts the server
rendered (and what they load) can execute. The nonce reaches Next's own inline
scripts through the `x-nonce` request header, and reaches Clerk and next-themes
as a prop from the root layout — both inject a script tag, and both would be
blocked without it. Every allowed origin is listed with the reason it is there;
Supabase's is derived from the environment so it can't drift.

`next.config.ts` adds `X-Content-Type-Options: nosniff`, `X-Frame-Options:
DENY`, `Referrer-Policy`, `Permissions-Policy` (camera only), HSTS in
production, and `Cross-Origin-Opener-Policy: same-origin-allow-popups` — the
`allow-popups` because Clerk's Google sign-in opens one. No COEP: it would
block Clerk's avatars and bot-check iframe.

**Verified in the browser:** Clerk loads and its modal renders; pdf.js runs as
a module worker and parses a PDF; page thumbnails render through `blob:`; the
UPI QR renders through `data:`. Zero policy violations after the nonce was
wired through. Every page is now server-rendered on demand, which the nonce
requires.

The one concession is `'unsafe-inline'` on **styles**: motion and GSAP write
inline `style` attributes every frame, and a nonce can't cover that. Inline
styles cannot run script.

### 4. Push endpoints — **fixed, 0014**

The dispatch route POSTs to whatever endpoint the browser stored. Real push
services are all `https` and none sit on a private address. `push_endpoint_sane`
rejects anything else, so the server can't be pointed at an internal host, and
`cap_push_subscriptions()` keeps ten per user, dropping the oldest rather than
refusing.

Also found while here: with no UPDATE policy on the table, re-enabling push
from the same browser failed — the upsert's conflict branch was refused by RLS.
Fixed with `own push update`, scoped to the owner so an endpoint can't be taken
over.

### 5. Shared-secret comparison — **fixed**

`provided !== secret` returns at the first differing byte, so response time
says how much of the prefix was right. `lib/server/secret.ts` hashes both sides
and compares with `timingSafeEqual`. Both maintenance routes use it, and the
`GET` readiness probes now require it too — they only reported booleans, but a
map of what a deployment lacks is still a map.

### 6. Rate limits — **fixed, 0014**

Twenty orders per user per hour, inside `place_order()` where it can't be
skipped. Uploads were already capped (60/hour, 500 MB) in 0012; reports at one
open per order in 0013.

### 7. Text lengths — **fixed, 0014**

Nothing bounded free text. Not an injection risk — see above — but a megabyte
in `payment_reference` is a card that never renders. Every student-written
column now has a `CHECK` on length, and `avatar_url` must be `https`.

### 8. Service worker navigation — **fixed**

`notificationclick` navigated to `payload.url`. The payload is signed with our
VAPID key, so it's trusted today — but a service worker outlives the code that
registered it. `sameOriginPath()` accepts only a relative path.

### 9. The handover QR was just the token — **fixed, 0016**

Tokens are sequential and printed on every slip on the shelf. The student's
QR carried only `printify:order:A03`, so anyone could make one in a free QR
generator, and the scan sheet — which showed a filename and a page count, not
a name — would have found A03 and offered *Handed over*.

Every order now gets a `handover_code`: eight hex characters from a v4 UUID,
set by the same trigger moment as the token, readable only by the owner and
the desk, and pinned by the write guard so a student can't set a known one.
The student's QR carries token **and** code; the slip's QR carries the token
only, because whoever holds the slip already holds the paper. The scanner
reports what it proved: **verified** when the code matched (the phone is the
owner's), **found, not verified** for a slip or a typed token (the customer's
name and roll number are shown for exactly that), and **wrong** when a QR
carries a code that belongs to no order with that token — in which case no
handover is offered at all.

Two smaller things closed in the same migration:

- A desk's tokens start again each day, so yesterday's uncollected A03 and
  today's A03 were ambiguous to a token-only lookup. A scan with a code picks
  the right one; a lookup without one lists both and asks.
- Token uniqueness relied on `assign_order_token()`'s upsert being atomic.
  It is — Postgres serialises the hundred concurrent inserts on one row per
  desk per day — but nothing *enforced* it. A unique index on
  `(operator_id, day, token)` now refuses a second A03 outright.

**Verified:** a hundred orders placed at one desk get a hundred distinct
tokens (A01 … A99, B01) and a hundred distinct codes; a forced duplicate
token is refused by the index; a student's attempt to change their code is
discarded by the guard.

**The wrong desk.** A scanner only ever searches its own desk's ready orders
— the query is filtered by `operator_id` and RLS returns nothing else — and it
cannot update another desk's order. So another operator scanning the code
could never hand the student's job over, or mark it collected. What they *could*
do was misread the situation: their own shelf often has an A03 too, and a code
mismatch used to say "made up, or another day". The QR now carries the first
eight characters of its desk's id; a scanner elsewhere says *"This order is
with Sharma Stationery, CEC — not here"* and offers nothing. Operators are
public, which is what lets it name the desk.

**What this doesn't cover:** a student who screenshots their QR and sends it
to a friend has delegated collection, the same as handing over a paper
ticket. That's a feature. And a desk that ignores *found, not verified* and
hands over anyway is a desk, not a system — the sheet makes the state
impossible to miss, but it doesn't take the button away.

### 10. Desk sign-in without Google — **added, 0018**

A counter changes hands three times a day. Signing each person in through
Google on a shared tablet was the wrong shape, so a shift now starts by
tapping a name and typing a PIN — but only on a device the desk has paired,
and the session that results is a normal Clerk session with nothing special
about it.

The pieces, and what each one is allowed to do:

- **Pairing.** A signed-in staff member pairs the device from Settings.
  `pair_device()` mints a 64-hex token, stores only its SHA-256 in
  `desk_devices`, and returns the token to that browser once; it lives in
  `localStorage` and is shown to nobody. A desk can hold ten live devices;
  any staff member can revoke any of them, and a revoked token lists no one.
- **The staff list.** `desk_staff(token)` is the only thing an unpaired,
  signed-out visitor could try, and it returns nothing without a live token.
  With one, it returns names and whether each has a PIN — no emails, no ids
  beyond what the tiles need. Nobody sees a desk's roster by loading a URL.
- **PINs.** Four to six digits, set by their owner while signed in through
  Google; `set_my_pin()` refuses `0000`, `1234`, `1111`, `123456`, `000000`
  and `111111`. Stored as a salted SHA-256 in `staff_pins`, never returned.
- **The check.** `/api/desk` validates the shape of the body, then calls
  `desk_verify_pin()` with the *anon* key — no service role, because the
  function is the gate: it requires the token to be live, the person to be
  on that desk's staff, and the digest to match. Five wrong tries lock that
  person's PIN for five minutes; the counter is per PIN, so one person's
  attempts don't lock the desk. The function returns a row rather than
  raising, because a raise would have rolled back the attempt counter it
  had just incremented. On success the route asks Clerk for a sign-in token
  for that user, good for sixty seconds, and the browser exchanges it for a
  session.
- **The session.** From that moment the app is exactly what it is after a
  Google sign-in. RLS, `is_staff`, the write guard, the scanner — none of
  them know or care how the session started. Signing out ("Switch staff")
  returns the device to the tile screen.

`/operator` is no longer redirected to Clerk's hosted sign-in at the edge,
because a paired device has to land there signed out. That removes nothing:
every row on the page is behind RLS, so the signed-out page without a paired
token is a sign-in prompt and empty space.

**Verified** in the SQL harness: pairing returns a token and lists the desk's
staff by it; a fake token lists nobody; weak PINs are refused; the right PIN
verifies; five wrong tries lock, a sixth right one is still refused, another
staff member's PIN is unaffected, and setting a new PIN unlocks; a revoked
device verifies nothing. `/api/desk` refuses a malformed body with 400 and an
unknown device with 401 and the database's own message.

**What this doesn't cover.** A PIN typed at a counter is typed in front of
people — the pad shows dots, not digits, and the lockout makes guessing slow,
but a four-digit PIN is a four-digit PIN. Staff who want more can set six.
And a paired device is a key: lose the tablet, revoke it in Settings, and it
is a tablet again.

### 11. Join codes replace applications — **0019**

The only way onto a desk's staff is now a code made by someone already on it
(or, for a brand-new desk, by an admin). A stranger with a form was never a
real path, and the review queue it fed was a place for mistakes; both are
gone — `operator_applications`, `approve_application`, `reject_application`.

What a code is worth, and what limits it:

- **Entropy.** Eight symbols from a 32-symbol alphabet: 2⁴⁰, about a trillion.
  Drawn from the random bytes of two v4 UUIDs, taking only the bytes that
  carry no version or variant bits; 256 divides by 32, so the draw is uniform.
- **Window.** One use, then it's spent (and records who spent it). Twenty-four
  hours. Revocable by the desk or an admin. Ten open codes per desk at most,
  which bounds what a guesser could ever hit.
- **Guess rate.** Every claim attempt is a row in `invite_attempts`; twenty in
  an hour and that account is told to wait. The function returns a verdict
  row instead of raising, because a raise would roll back the attempt row it
  had just written — the same trap `desk_verify_pin` had, and the harness
  caught it here too before it shipped.
- **Nothing on page load.** The link inside the QR opens a page with the code
  filled in; joining is a tap. A link pasted into the wrong chat and clicked
  by the wrong person still needs that person to choose to join, and when
  they do the code is spent and the desk sees who took it.
- **What joining grants.** The same as before: full staff of that desk, no
  more. The desk's owner made the code on purpose; the risk of a stray code
  is the desk's, and it's one revoke away.

**Verified** in the SQL harness: an admin creates a desk and gets an owner
code (a student can't); the code joins whoever claims it, typed in any case
with a dash and a space, exactly once; expired and revoked codes are dead; a
non-staff account can't mint; the twenty-first guess in an hour is refused
while another account still gets a plain "not known"; the applications table
and both functions no longer exist.

### 12. Two doors, one lock

The student site signs in with Google only; the desk with email and
password (or a PIN on a paired device). Both are Clerk custom flows over the
same instance, so nothing about *what a session can do* changed — `is_staff`
and RLS still decide everything — and Clerk still does the hashing, the
HaveIBeenPwned check, the emailed codes and the bot check on account
creation (rendered inside the page in `#clerk-captcha`, which the CSP already
allowed for the hosted modal).

Three details worth knowing:

- **Return addresses.** Clerk sends people to `/sign-in?redirect_url=…` with
  an absolute URL. `sameOriginPath()` keeps it only if it is exactly this
  origin's, and then keeps only the path and query — `//evil`, `/\evil` and
  `http://localhost:3000.evil.com` all fall back. Push payload URLs go
  through the same function in the service worker.
- **Cross-host hops** are 307s built from the request's own host header and
  the two configured hosts — never from a value in the URL — so a request
  can't be bounced anywhere the deployment wasn't told about.
- **The desk's pushes** go only to subscriptions flagged `desk`, which only
  the desk's own settings page writes; a student's device never receives a
  desk's "new order" line, and a desk device still gets its owner's own
  "ready" pushes because student rows aren't filtered.

**Verified:** the routing table row by row in `check:features`; both hosts
of a split-mode production server with `curl`; the doors in the browser.

### 13. The platform fee is priced where the price is — **0022**

A fee the browser computed would be a fee the browser could omit. So it
isn't: `place_order()` reads `platform_settings` and adds the fee inside
the same transaction that prices the lines, in the same double-precision
arithmetic `quoteOrder()` uses, and the harness's 144-job grid runs at an
awkward 3.25% so the fee's own rounding is exercised alongside the lines'.
The percentage is snapshotted into `rate_card`; `guard_order_update()` pins
`platform_fee`; `check:features` asserts the pin.

What the ledger trusts, and what it doesn't: the amounts owed are sums
over `orders` — collected, not fully refunded — and no function accepts an
amount to *add* to them. The only write is `record_settlement()`, admin
only, which records a payment the admin says arrived; `fee_balance()` is
owed minus that. A desk can read its own window and balance
(`is_staff`), the admin every desk's; anon gets nothing. Changing the rate
is `set_platform_fee()`, admin only, bounded 0–25%, and touches only
orders placed afterwards — verified.

### Reviewed and left alone

- **No XSS sinks.** No `dangerouslySetInnerHTML`, `innerHTML`, or `eval` anywhere.
- **Dependencies.** `npm audit`: 0 vulnerabilities, production and dev.
- **Secrets.** `.env*` is ignored; only `NEXT_PUBLIC_*` values reach the bundle,
  and each of those is meant to be public. The service-role key and the
  webhook secret are read only inside route handlers.
- **Admin bootstrap.** Removed in 0020. `claim_first_admin()` let the first
  signed-in person take the seat while the table was empty — which, right
  after a reset, is the moment a stranger could. Now nothing in the app
  writes `admins`; the harness asserts there is no such function and the
  table's only policy is a read. The admin is whoever can open the Supabase
  dashboard and run one `INSERT`.
- **Admin reach.** An admin can create a desk and make a join code for a
  desk with nobody on it. Once someone is on staff, `can_invite_for()` shuts
  the admin out: no codes, no revokes, no listing of the desk's codes, and
  `admin_desks()` reports a head count, never names. Staff is the desk's.
- **Signed URLs** for operator file access expire in 300 seconds.
- **`operators` is publicly readable**, including `upi_vpa`. Students have to
  pay to it, so it is public by design. Stock levels are also visible; that is
  business information, not a security boundary.
- **Realtime** uses `postgres_changes`, which applies RLS per subscriber.
- **`queue_status(uuid)`** is callable by anon and takes an order id. Ids are
  v4 UUIDs; a guessed one returns a queue position and a wait, nothing else.

## Still open

- **The SQL harness cannot prove RLS.** It runs PGlite as superuser, and
  superusers bypass row-level security. Every policy in this document has been
  read; none has been executed against a non-superuser role. The honest way to
  close this is a real Supabase project with two test accounts and a script
  that tries to cross them.
- **Page counts are client-reported** (finding 1). Server-side counting needs
  the server to open the file, which needs Gotenberg or pdf.js on a server.
- **No abuse reporting** for a student who fills their quota with junk; the
  caps hold, but nobody is told.
- **No error monitoring**, so a client-side failure is invisible unless
  someone says.

## Running the checks

```bash
npm run check          # types, pricing, features, secret comparison, SQL
npm run check:sql      # migrations + triggers + pricing equivalence, no Docker
```

The security-relevant scenarios in `check:sql`, by name:

- a student cannot rewrite their own total
- a student cannot fake a refund
- place_order prices exactly what the browser showed (144 jobs)
- a file that isn't yours can't go on your order
- a document row can't point at someone else's file
- a push endpoint on a private address is refused
- the order rate limit holds
- the upload ceiling holds
- a bad print can be reported once
- a hundred orders at one desk get a hundred distinct tokens and codes
- a student's handover code can't be set to a known one
- desk sign-in: fake token lists nobody, weak PINs refused, lockout after five, revoked device dead
- join codes: admin-only desk creation, one use, expiry and revocation, twenty guesses then wait
- admin: shut out of a staffed desk's codes; no function or policy writes `admins`
- a new order pushes to staff with a desk device, and only them
- the platform fee: to the paisa on top of the minimum; floored; student refused the rate; pinned; ledger excludes a full refund; settlements admin-only
