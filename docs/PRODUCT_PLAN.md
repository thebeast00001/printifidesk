# Campus Print Service — Product & Engineering Plan

> Status: draft v1 · Owner: Ansh · Stack: Next.js (App Router)

---

## 0. Assumptions I'm building on

Flag anything wrong here, because several decisions below hang off it:

| # | Assumption | Why it matters |
|---|---|---|
| A1 | India, single college to start, expand to nearby campuses | Drives UPI/Razorpay, WhatsApp, ₹ pricing, hostel delivery |
| A2 | **You** own fulfilment (your own printer(s) / a tied-up shop), not a marketplace of vendors | No vendor onboarding, payouts, or bidding in v1 — huge scope saving |
| A3 | Mobile-first. ~90% of orders come from a phone, on flaky campus wifi | Resumable uploads, PWA, tiny bundles, no desktop-only flows |
| A4 | Peak load is exam week + assignment deadlines, not steady traffic | Queue + slot capacity + surge handling matter more than raw scale |
| A5 | Price point ₹1–2/page B/W. Margin is thin, volume is the game | Every rupee of payment-gateway and storage cost matters |

**Naming warning:** `Printify` is an established print-on-demand company (printify.com) with an active trademark. Fine as a working repo name, but pick something else before you put it on a poster. Ideas: *PrintPoint, Xeroxly, Campus Press, PrintDesk, Sheetly, QuickPrint, PrintKaro*.

---

## 1. The product in one line

**Upload from your phone, pay with UPI, collect a printed set — under 45 seconds to order, live status the whole way.**

The competitor isn't another app. It's *walking to the shop with a pen drive and standing in a queue*. So the whole product is judged on one axis: **is this less friction than walking there?** Every feature below is scored against that.

### The four users

| Role | Who | Primary surface |
|---|---|---|
| **Student** | Customer | Mobile web / PWA |
| **Operator** | Whoever runs the printer | Tablet/desktop queue board + local print agent |
| **Runner** | Delivery to hostel/class (phase 2) | Mobile runner view |
| **Admin** | You | Analytics, pricing, coupons, support |

### The core loop

```
Upload → Configure → See price → Pay → Queue → Print → Ready → Collect
   ↑                                                              │
   └──────────────── Reorder in 1 tap ────────────────────────────┘
```

---

## 2. Student features

### 2.1 Auth & onboarding

- **No login until payment.** Configure and price your order as a guest; account is created silently at checkout from the phone number.
- Phone OTP as primary (MSG91 / Twilio Verify), Google sign-in as secondary.
- Optional college-email verification → unlocks campus pricing / campus-only features.
- Magic tracking link (`/t/<token>`) works with no account at all — sent over SMS/WhatsApp.
- Profile: name, phone, roll no., department, hostel + room, default print preferences.

### 2.2 Upload

This is where most competing products fall apart. Get it right.

- **Sources:** device files, drag & drop, multi-file, whole folder, Google Drive picker, camera scan (auto edge-detect + deskew → PDF), paste a link, WhatsApp forward (phase 3).
- **Formats in:** PDF, DOCX, PPTX, XLSX, TXT, JPG/PNG/HEIC, code files. Everything converts to PDF server-side before it ever reaches a printer — never trust the operator's Word to render your margins the same way.
- **Resumable/chunked uploads** (tus or S3 multipart). Campus wifi drops. An upload that survives a lift ride is a real feature.
- Client-side page count + thumbnail preview (pdf.js) so price appears *instantly*, server re-verifies before charging.
- Guard rails, all surfaced early and in plain language:
  - password-protected PDF → prompt for password, or reject with a clear reason
  - corrupt/unrenderable file → reject at upload, not at the printer
  - size + page caps per order
  - virus scan (ClamAV) on every file
- **Saved documents library** — re-print last semester's lab manual in two taps.

### 2.3 Print configuration

Per file, with a prominent **"apply to all files"**.

| Group | Options |
|---|---|
| **Color** | B/W · Full color · **Smart color** (auto-detects which pages actually have color and charges B/W rate for the rest) |
| **Sides** | Single · Double (long/short edge) |
| **Paper** | A4 70gsm / 80gsm / 100gsm · A3 · Glossy · Letterhead |
| **Copies** | 1–N, with bulk slabs |
| **Pages** | All · Range · Visual page picker with thumbnails · Odd/even |
| **Layout** | 1 / 2 / 4 / 6-up · Booklet fold · Scale-to-fit · Orientation |
| **Binding** | None · Corner staple · Side staple · Spiral · Soft/tape · Hard bind |
| **Finishing** | Punched holes · Cover page (plain/transparent/custom) · Cover lamination |
| **Notes** | Free-text special instructions to the operator |

**Smart color detection is the standout feature.** Students hand over a 120-page report with 4 colored charts and get billed full color at a shop. Detecting per-page ink coverage server-side (Ghostscript `inkcov`) and billing accordingly is a genuine, quantifiable saving you can advertise: *"You saved ₹412 vs full-color printing."*

### 2.4 Pricing & payment

- **Live itemised breakdown** that updates as you toggle — no surprises at checkout.
- Rules engine: per-page rates by paper/color/sides, binding flat rates, bulk slabs (e.g. 100+ pages cheaper), delivery fee, express fee, taxes.
- **Wallet / credits** — top up ₹200 once, then every future order is one tap and zero gateway fees. Best retention lever you have, and it cuts your payment costs.
- Coupons, first-order discount, referral credits.
- **Group orders** — one person uploads class notes, generates a share link, 40 classmates join, everyone pays their own share, you print one batch. Very high value in a college, near-zero elsewhere. Big differentiator.
- **Pay for a friend** — cover someone else's pickup.
- Payment: Razorpay (UPI intent, UPI collect, cards, netbanking). Webhook-confirmed, idempotent, with a reconciliation job for the "money left the account but the order didn't create" case.

### 2.5 Fulfilment & live tracking

- **Choose how you get it:** counter pickup · locker (later) · hostel delivery · classroom delivery slot.
- **Slot picker with real capacity** — "Today 4–6 PM · 3 slots left". Never let the queue oversell.
- **Express** ("ready in 20 min", surge-priced) and **Scheduled** ("ready by 8 AM, before my 9 AM class").
- **Live order timeline**, pushed in realtime:
  ```
  Received → Paid → In queue (#4, ~12 min) → Printing → Binding →
  Quality check → Ready for pickup → Out for delivery → Delivered
  ```
- Live queue position and a live ETA countdown. Transparency beats speed — people wait happily if they can *see* the queue.
- Notifications on every meaningful transition: web push + WhatsApp/SMS + email. Configurable, not spammy.
- **Pickup QR / 4-digit token.** Operator scans, handover confirmed, receipt auto-sent. No "what's your name?" at the counter.
- Cancel + auto-refund any time before the job enters `PRINTING`.
- **Problem reporting** with photo upload → reprint request flow → operator sees it in queue as a priority job.
- Rate the order. Ratings feed the operator dashboard.

### 2.6 Trust & privacy — the real objection

People are handing you their assignments, ID proofs, medical reports, and answer keys. If this feels sketchy, they walk to the shop instead. Treat it as a headline feature, not a footer link.

- **Auto-delete after print** — files purged N hours after delivery, with the countdown *shown to the user*.
- Encrypted at rest, short-TTL signed URLs, never a public link, no directory listing.
- Per-file access audit log the student can view: who opened it, when.
- Operator access is scoped to the print action and logged.
- A plain-English privacy page, linked from the upload screen where the doubt actually occurs.

### 2.7 Campus-native extras (the moat)

These are why a generic print service can't beat you:

- **Assignment cover-page generator** — pick your university format, autofill name/roll/subject/date, print with the assignment. Every student needs this every week.
- **Lab file / project report templates** per department.
- **Shared notes library** — seniors upload PYQs, lab manuals, unit notes; juniors print directly. Uploader earns credits. *Copyright policy required: user-original or explicitly licensed material only, with takedown flow — do not host scanned textbooks.*
- Passport/ID photo printing (crop to spec, 8-per-sheet).
- Stationery add-ons at checkout — folders, sheet protectors, pens. Real margin on near-zero effort.
- Referral program.

---

## 3. Operator dashboard

The operator experience decides whether the promised SLA is real. Design it for someone standing at a printer, not sitting at a desk.

- **Live Kanban queue:** New → Printing → Binding/Finishing → Ready → Handed over. Auto-sorted by deadline, express jobs pinned.
- **One-click print via a local Print Agent** (see §5) — the job spools with the correct color/duplex/paper/copies settings automatically. This eliminates the single biggest source of errors and delay: a human re-entering print settings.
- **Batching** — group all "A4 · B/W · duplex" jobs into one printer run.
- Job detail: preview, config checklist, page count, deadline, cost, special instructions.
- **Exception buttons** with one tap: paper jam · out of toner · corrupt file · printer down → student is auto-notified with the actual reason and offered hold/refund. Honest failure is a feature.
- **Handover:** scan the student's QR → confirm → receipt sent.
- Consumables tracking: paper stock, toner, printer health. Low-stock alerts.
- Shift summary + cash/settlement report.
- **Offline resilience** — queue continues to function on a dropped connection and syncs on reconnect.

---

## 4. Admin (you)

- Multi-campus / multi-shop management.
- Pricing rules per campus, per paper type, per binding. Versioned, so old orders keep their historic price.
- Coupons, referrals, wallet adjustments.
- **Analytics:** orders, revenue, GMV, AOV, pages printed, repeat rate, peak-hour heatmap, **margin per order** (price vs paper+toner cost), SLA breach rate, cancellation reasons, funnel drop-off (upload → configure → pay).
- Demand forecasting for exam weeks → staff and stock ahead of the spike.
- Moderation queue for flagged uploads.
- Support inbox / tickets tied to orders.
- Feature flags + maintenance mode.

---

## 5. Technical architecture

### Stack

| Layer | Choice | Note |
|---|---|---|
| App | **Next.js 15 App Router + TypeScript** | Server Actions for mutations, RSC for the dashboards |
| UI | Tailwind + shadcn/ui + Framer Motion | Mobile-first, dark mode, PWA manifest |
| Auth | Auth.js with phone OTP, or **Clerk** if you want it done in an afternoon | |
| DB | **Postgres** (Neon or Supabase) + **Prisma** | |
| Files | **Cloudflare R2** (S3 API, zero egress fees) + presigned uploads | Egress is your hidden cost — R2 kills it |
| Conversion | **Gotenberg** container (LibreOffice + Chromium) | DOCX/PPTX/XLSX/HTML → PDF |
| PDF ops | `pdf-lib`, `pdfjs-dist`, `qpdf` (decrypt), **Ghostscript** (`inkcov` for color detection, n-up, page range) | |
| Jobs | **BullMQ + Redis** (Upstash) | conversion, thumbnails, color analysis, notifications, purge |
| Realtime | Pusher / Ably / Supabase Realtime, or plain SSE | live tracking + operator board |
| Payments | **Razorpay** (webhooks, refunds, idempotency keys) | Stripe if you ever go international |
| Messaging | WhatsApp Cloud API + MSG91 SMS + Web Push (VAPID) + Resend (email) | |
| Print agent | Node service on the shop PC — CUPS/IPP on Linux/Mac, SumatraPDF CLI on Windows | |
| Observability | Sentry + PostHog + Axiom | |
| Hosting | Vercel (web) · Fly.io or Railway (workers + Gotenberg) · R2 (files) | |

### Why a local Print Agent

A tiny always-on Node process on the shop machine that:
1. long-polls / subscribes for jobs assigned to its printer,
2. downloads the normalised PDF via a signed URL,
3. applies exact settings (`-o sides=two-sided-long-edge -o ColorModel=Gray -n 3 …`),
4. spools to the printer, watches CUPS job state,
5. reports `PRINTING → PRINTED` or the failure reason back.

Without this, "extremely smooth" is a lie — a human is retyping print settings for every job and getting them wrong under exam-week pressure. With it, the operator taps once.

### File pipeline

```
upload (resumable, presigned)
  → virus scan
  → decrypt if needed (qpdf)
  → convert to PDF (Gotenberg)
  → normalise page size / rotation
  → page count + per-page ink coverage (Ghostscript inkcov)
  → thumbnails
  → price recompute + confirm against client estimate
  → store normalised PDF (this is what prints, always)
  → schedule auto-purge
```

### Data model (first cut)

```
College, Campus, Shop, Printer
User, Address
Document        (original + normalised, pageCount, colorPages[], purgeAt)
PrintConfig     (color, sides, paper, copies, range, nUp, binding, finishing, notes)
Order → OrderItem (document + config + computed price)
OrderStatusEvent (append-only timeline, powers tracking + audit)
Payment, Refund, WalletTransaction
PriceRule (versioned), Coupon, Referral
DeliverySlot, Runner
Notification, SupportTicket, Rating
InventoryItem, PrinterHealthEvent
FileAccessLog
```

### Order state machine

```
DRAFT → PENDING_PAYMENT → PAID → QUEUED → PRINTING → FINISHING
      → READY → (OUT_FOR_DELIVERY) → COMPLETED

any → CANCELLED (student, only before PRINTING; auto-refund)
any → FAILED    (operator, with reason; auto-refund or hold)
     REPRINT_REQUESTED → QUEUED (priority)
```

Enforce transitions server-side in one place. Every transition writes an `OrderStatusEvent` — that single table gives you the tracking timeline, the audit trail, the SLA metrics, and the debugging story for free.

### Security & compliance

Signed URLs with short TTL · rate limiting (Upstash) · RBAC (student/operator/runner/admin) · full audit log on file access · ClamAV · PII minimisation · scheduled hard-purge job · a real privacy policy and T&C · GST invoicing if you cross the threshold · copyright takedown process for the notes library.

---

## 6. Unit economics (sanity check before you build)

| Line | Est. |
|---|---|
| Price to student, B/W A4 | ₹1.50 / page |
| Paper | ~₹0.30 |
| Toner/drum/maintenance | ~₹0.40 |
| Payment gateway (~2%) | ~₹0.03 |
| Storage/compute, amortised | ~₹0.02 |
| **Gross margin** | **~₹0.75 / page (≈50%)** |

Implications you should design around:
- Binding and color are where the actual money is — surface them well.
- Wallet top-ups remove gateway fees on every subsequent order. Push them hard.
- Delivery must be batched (one runner, one hostel, many orders) or it eats the entire margin.
- 500 pages/day ≈ ₹375/day gross. **Volume and repeat rate are the whole business** — hence the campus-native features in §2.7.

---

## 7. Roadmap

### Phase 0 — MVP (target ~2 weeks)
Ship the thinnest thing that actually replaces a walk to the shop.

- Phone OTP auth + guest checkout
- PDF upload (resumable) + preview + page count
- Core config: color, sides, copies, page range, binding
- Live price calculation
- Razorpay checkout + webhook
- Order creation + pickup token/QR
- Operator queue board (manual print, mark status)
- Status notifications via SMS/WhatsApp
- Basic admin: orders list, pricing config

### Phase 1 — Smooth
- DOCX/PPTX/image conversion (Gotenberg)
- **Smart color detection** + savings display
- Realtime tracking, live queue position, ETA
- Wallet + credits, coupons, referrals
- Saved documents + 1-tap reorder
- Web push, PWA install
- Cancel/refund, reprint request flow

### Phase 2 — Scale ops
- **Local print agent** (automated spooling)
- Batch printing, printer routing
- Hostel/classroom delivery + runner app + slot capacity
- Group orders / split payment
- Cover-page + lab-file template generator
- Consumables tracking, analytics dashboard

### Phase 3 — Moat & expansion
- Multi-campus, multi-shop
- Shared notes library (with copyright controls)
- WhatsApp bot ordering
- Smart pickup lockers
- Demand forecasting, dynamic slot pricing
- Stationery store

---

## 8. Risks & edge cases to design for now

| Risk | Mitigation |
|---|---|
| Client page count ≠ server page count → wrong charge | Always re-verify server-side before capture; auto adjust/refund the delta |
| Payment succeeded, order didn't create | Idempotent webhook + reconciliation cron + support view |
| Printer dies mid-job | Agent reports failure → auto-requeue to another printer or notify + refund |
| Exam-week spike | Slot capacity caps, queue transparency, surge for express, pre-warned staffing |
| Refund abuse ("it was misprinted") | Require photo, track per-user reprint rate, cap free reprints |
| Copyright — textbook scans in the notes library | Upload policy, moderation queue, takedown process, uploader accountability |
| Privacy incident with student documents | Short TTL, purge job, audit log, least-privilege operator access |
| Campus politics — existing shop, admin permission | Partner with the incumbent shop rather than compete; get written permission |
| Trademark on "Printify" | Rename before any public branding |
| Corrupt/exotic files reaching the printer | Normalise everything to PDF server-side; reject at upload with a clear reason |

---

## 9. What "extremely smooth" actually means

Concrete, testable targets. If a feature doesn't serve one of these, cut it.

1. **Under 45 seconds** from opening the site to payment confirmed, for a repeat user.
2. **Zero forced login** before the price is visible.
3. **Price is never a surprise** — live, itemised, final.
4. **Never a dead end.** Every error says what happened, why, and what to do next.
5. **Always know where your order is.** Live status, live queue position, live ETA.
6. **Config persists.** Close the tab mid-order, come back, everything's there.
7. **Smart defaults.** Second order pre-fills from the first.
8. **Proactive on failure.** If the printer jams, the student hears it from *us* before they walk over.
9. **One-thumb operable.** No pinch-zoom, no desktop-only controls.
10. **Fast.** LCP < 2.5s on 4G, interactions < 100ms, optimistic UI everywhere.
11. **Delightful at the finish.** Live progress ring, a genuine "Ready! Token #A47" moment.
12. **Accessible.** Keyboard nav, screen-reader labels, WCAG AA contrast, dark mode.

---

## 10. Open decisions — need your call before Phase 0

1. **Fulfilment model** — your own printer, or a tie-up with an existing campus shop? (Changes whether you need vendor payouts.)
2. **Pickup only for v1, or delivery from day one?** (Delivery roughly doubles MVP scope.)
3. **Payment gateway** — Razorpay assumed. Do you have/can you get a business account + GST? If not, v1 may need pay-on-pickup.
4. **Campus** — which college, how many students, is there an existing shop to partner with or beat?
5. **Auth provider** — Clerk (fast, paid past free tier) vs Auth.js (free, more work).
6. **Print automation in MVP?** — manual operator printing is fine for v1 volumes; the agent can wait for Phase 2.
7. **Final name.**
