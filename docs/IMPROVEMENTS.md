# Printify — what to improve next

A walk through the whole journey, ordering → handing over, on both sides.
Ordered by what it costs you to *not* fix, not by effort.

---

## Status, as of this round

Built and passing `npm run check` + `npm run build`:

| | |
|---|---|
| 0 | Operator can open the file — `claim_document_access` + storage policy, `0011` |
| 1.1 | Web push — `lib/push.ts`, `public/sw.js`, dispatch sends push before WhatsApp |
| 1.2 | QR handover token in the status island |
| 1.3 | Per-file print settings — `order_items.config`, `0013` |
| 1.5 | UTR field on the pay sheet, frozen once the operator confirms |
| 1.9 | Report a bad print — `order_reports`, `0013` |
| 1.6 | Live countdown from `ready_at` / queue position |
| 2.1 | Audible alert — synthesised chime + browser notification |
| 2.3 | Editable opening hours, feeding the pickup slots |
| 2.5 | Consumables with auto-close at zero |
| 2.6 | Student contact on the card, readable only while the order is live |
| 2.7 | End of day — takings, cash/UPI split, CSV export |
| 2.8 | Refunds, recorded not sent |
| 2.9 | `operator_stats_range()` over today / 7 / 30 days |
| 3.1 | Automatic purging — `purge_at` trigger + `/api/maintenance/purge` |
| 3.2 | File access audit — `document_access_log` |
| 3.4 | Rate limiting — `enforce_upload_limits`, `0012` |
| 5 | Realtime latency — paint from the pushed payload |
| — | Operator round (Sept 2026): scan-to-hand-over, messages, close-out, staff, stock ledger, next-up, age badges, scheduled timeline, job slip — `0015` |

Also closed while implementing 2.8: `guard_order_update()` did not pin the
refund columns `0011` added, so a student could have written `refunded_at` on
their own order. Fixed in `0012`, and `npm run check` now asserts the pinned
column list so the next added column can't repeat it.

Also built this round, and not from the list above: the option chips now carry
what picking them would cost, the queue estimate reads as a clock time as well
as a countdown, declined and failed orders have an action instead of ending in
a sentence, and an empty shelf shows the operator's real rate card.

Still open, and listed in the README's *Not built yet* for the same reason:
**1.4** resumable uploads, **1.7** camera scan, **1.8** reprint, **2.2** batch
printing, **2.4** staff management, **3.3** abuse reporting, **4.1–4.3**
monitoring and analytics.

---

## 0. The blocker: the operator cannot open the file — done

**This is not a polish item. The product cannot work end to end today.**

Storage policy, from `0001_init.sql`:

```sql
create policy "own files read" on storage.objects for select
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = public.clerk_id());
```

Only the uploader can read their file. The operator's portal lists filenames and
page counts, but there is **no way for them to download or print the document**.
Every test so far has exercised ordering and status — never actually printing.

**Fix:** a second storage policy granting read to staff of the operator the file
was ordered from, joined through `order_items → orders → staff`, plus a
**Download all** / **Print** action on the order card that fetches short-lived
signed URLs. Scope it to orders that are still live, so a collected job stops
being readable.

Do this before anything else on this list.

---

## 1. Highest impact for the student

### 1.1 Web push for "ready" — without needing WhatsApp credentials — done
The WhatsApp pipeline is built but gated on a Business API token you don't have.
Meanwhile a student who closes the tab learns nothing. Web Push works today, is
free, needs no provider, and the app is already a PWA (`manifest.ts`). One
service worker plus a `push_subscriptions` table and the existing
`notifications` queue drains into it. **Biggest experience win available right now.**

### 1.2 A QR token for handover — done
The student has a token; the operator types or searches it. Render the token as
a QR on the student's screen and let the operator scan it with the same camera
input already used for document scanning. Handover goes from ~15 seconds of
"what's your name" to under two.

### 1.3 Per-file print settings — done
Colour, sides and binding apply to the whole order. A student printing a colour
cover plus a 40-page black-and-white body has to place **two orders**, pay twice
and collect twice. `order_items` already exists — move `config` onto it and let
the sheet override per file, defaulting to the job-level setting.

### 1.4 Resumable uploads
`uploadToStorage` is a single XHR. On campus wifi a dropped connection loses a
50 MB file entirely and the student starts over. Supabase Storage supports
resumable (TUS) uploads; the progress UI is already built for it.

### 1.5 Paste the UPI reference (UTR) — done
Payment is honour-system: the student says they paid, the operator checks their
app. Ask for the 12-digit UTR on the "I've paid" step and show it on the
operator's card. Costs one input field, turns a guess into a lookup.

### 1.6 A live countdown, not a static number — done
"About 8 min" is computed once and sits there. Tick it down from `queued_at`
using the same throughput figure. Waiting is tolerable when it visibly moves.

### 1.7 Multi-page camera scan
Scan captures one image per shot as separate files. Let the student shoot a
sequence and merge to a single PDF client-side (`pdf-lib`), with edge detection
and deskew. Lab records and handwritten notes are the highest-volume campus job.

### 1.8 Reprint in one tap
Stored documents open the sheet at step one. Add **Order again** that jumps
straight to payment with the previous settings, from `/orders` history.

### 1.9 Report a bad print — done
No path exists for a misprint. A **Something's wrong** button with a photo
upload, creating a reprint at zero cost and a note on the operator's queue.
Trust depends on the failure path more than the happy one.

---

## 2. Highest impact for the operator

### 2.1 An audible alert on a new order — done
The portal updates live but assumes someone is watching it. A short sound plus a
browser notification when an order lands in **New**. Without it the queue tab
count is useless while they're at the machine.

### 2.2 Batch printing
At exam-week volume the operator taps through orders one at a time. Group every
queued job with identical settings (A4 · mono · duplex) into one selection with
one **Print batch** action.

### 2.3 Editable opening hours — done
`opens_at` / `closes_at` are only changeable in SQL. They feed the pickup slot
generator, so an operator who works evenings cannot offer correct slots.

### 2.4 Staff management — done, then redone (0019)
`staff` supports many people per operator but only SQL can add them. A desk run
in shifts needs the owner to invite a second account from the portal. First
version asked for the colleague's sign-in email and needed them to have signed
in already; now *Add someone* makes a join code (QR, link, or eight characters
read across the counter), they open it on their own phone, sign in once, and
they're on. The same code brings a new desk's owner in from `/admin`; the
application form and review queue are retired.

### 2.5 Consumables, with auto-close — done
Paper and toner counters that decrement as pages print, warn at low, and flip
Printify closed at zero. Prevents the worst outcome: taking orders you cannot
fulfil.

### 2.6 Student contact on the order card — done
The operator sees a token and filenames. For a dispute, an unclear file, or a
no-show they need a name and phone. `profiles` has both; the join and an RLS
policy scoped to their own orders are missing.

### 2.7 End of day — done
A closing summary: orders, pages, cash vs UPI split, expected total, uncollected
jobs. Plus CSV export — every small shop reconciles at closing time.

### 2.8 Refunds — done
A declined order that was already paid has no path back. Record a refund against
the order with a reason, visible to the student.

### 2.9 Longer horizon stats — done
`operator_stats()` is today-only. Week and month, plus a busiest-hour breakdown,
is what tells an operator when to staff up.

### 2.11 Two sites — done
The desk is its own site: `desk.printify.app`, its own door (email and
password, or a PIN on a paired device), its own installable app with its own
mark, new-order pushes to its own devices, and no student chrome anywhere.
The student site never shows a desk link. One codebase, one database; the
host picks the site and `lib/surface.ts` is the whole rule.

### 2.10 Desk sign-in: a name and a PIN, not Google — done (0018)
A shared counter tablet changes hands every shift; a Google sign-in each time
was the wrong shape. Pair the device once from Settings, then a shift starts
by tapping a name and typing a PIN. The PIN is checked in Postgres, the route
mints a sixty-second Clerk sign-in token, and the result is an ordinary
session — nothing downstream knows the difference. Lockout after five wrong
tries; revoke a lost device from the same panel. Pair with a 30-day session
lifetime in the Clerk dashboard so the desk stays signed in between shifts.

---

## 3. Trust, safety and correctness

### 3.1 Automatic file purging — done
`documents.purge_at` exists and nothing enforces it. The UI currently promises
only manual deletion — honest, but weaker than it should be. A `pg_cron` job
plus a storage sweep makes the stronger promise true.

### 3.2 File access audit — done
Once operators can read documents (§0), record every access: who, which file,
when. Show it to the student. This is what makes handing over a medical
certificate or an ID scan acceptable.

### 3.3 Abuse reporting
No path to report a document that shouldn't be printed, and no operator ability
to refuse-and-flag rather than just decline.

### 3.4 Rate limiting — done
Nothing stops an account uploading a thousand files. Cap per-hour uploads and
total stored bytes per account.

---

## 4. For you, running the platform

### 4.1 Error monitoring
No Sentry. Every failure so far surfaced because you hit it and reported it.

### 4.2 Platform analytics
No view of GMV, active operators, orders per day, or the funnel from upload to
collection. You cannot tell whether the product is working.

### 4.3 Conversion instrumentation
Where do students drop? Between upload and options? At payment? Nothing is
measured, so §1 is currently ranked by judgement rather than data — worth fixing
early so the *next* version of this list is evidence-based.

---

## 5. Already done this round — realtime latency

The status a student sees now updates in roughly the socket round trip rather
than several hundred milliseconds.

**What was wrong:** every push discarded its payload and re-fetched — a session
check, then `activeOrder()`, `orderEvents()` and `queueStatus()` — before
anything moved on screen. The socket delivered in ~50 ms and the UI waited on
three more round trips.

**What changed:**

| | Before | After |
|---|---|---|
| Status change → pixels | push + 3–4 queries | push, painted from the payload |
| Subscription scope | every order in the system | `user_id=eq.…` / `operator_id=eq.…` |
| Socket drop | silent freeze | visible, and polls until it recovers |
| Timeline | full refetch | appended from the pushed row |

Queue position and aggregate stats still refetch, deliberately — they're derived
from other people's rows, so they can't come from your own payload. They land a
beat behind the status, which is the right trade.

`0010_realtime_tuning.sql` sets `REPLICA IDENTITY FULL` on the three replicated
tables. Without it Postgres ships only the primary key for the old tuple, and a
filtered UPDATE can silently fail to match — which would have made the new
filters *worse* than no filter at all.
