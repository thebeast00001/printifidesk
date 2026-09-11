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
| Staff vs student | `public.staff` table, read by `is_staff()` | Written only by `approve_application()` (admin) or manual SQL. |
| Admin | `public.admins`, read by `is_admin()` | First seat via `claim_first_admin()` under a table lock; no other write path. |
| Order price | `place_order()` RPC (0014) | The browser never writes a total. See below. |
| Order changes | `guard_order_update()` trigger (0009, 0012) | Pins every column a student may not touch, by name. |
| Files | Storage RLS keyed on the path's first folder | Path is `<clerk id>/<doc id>-<name>`; `documents_path_owned` (0014) ties the row to it. |
| Operator file access | `claim_document_access()` RPC + storage policy (0011) | Logged per open; only while the order is live. |
| Handover | `handover_code` in the student's QR (0016) | Per-order secret; the slip's QR has none. Scanner reports verified / found / wrong. |
| Maintenance routes | `NOTIFY_WEBHOOK_SECRET`, compared in constant time | Clerk middleware skips `/api/`; the secret is the whole gate. |
| Desk tools (0015) | RPCs check `is_staff` themselves; tables have read policies only | Messages: staff insert, owner reads. Stock and close-outs: no client insert path at all. Staff: `add_staff` looks up by email, `remove_staff` refuses to empty the desk. |
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

**What this doesn't cover:** a student who screenshots their QR and sends it
to a friend has delegated collection, the same as handing over a paper
ticket. That's a feature. And a desk that ignores *found, not verified* and
hands over anyway is a desk, not a system — the sheet makes the state
impossible to miss, but it doesn't take the button away.

### Reviewed and left alone

- **No XSS sinks.** No `dangerouslySetInnerHTML`, `innerHTML`, or `eval` anywhere.
- **Dependencies.** `npm audit`: 0 vulnerabilities, production and dev.
- **Secrets.** `.env*` is ignored; only `NEXT_PUBLIC_*` values reach the bundle,
  and each of those is meant to be public. The service-role key and the
  webhook secret are read only inside route handlers.
- **Admin bootstrap.** `claim_first_admin()` takes an exclusive table lock
  before checking emptiness, so two simultaneous claims can't both succeed.
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
