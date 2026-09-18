import Link from "next/link";
import { Contact, H2, LegalPage } from "@/components/legal/legal-page";
import { canonical } from "@/lib/seo";

export const metadata = {
  title: "Terms of service",
  description: "How Printifi works between you, the print desk, and Printifi itself.",
  alternates: { canonical: canonical("/terms") },
};

/** The rules, in the product's own voice, describing what it actually does. */
export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" sub="How Printifi works between you, the print desk, and Printifi itself.">
      <p>
        Printifi connects people who need something printed with independent print desks on campus. The
        desk does the printing and takes your payment; Printifi is the software in between. Using Printifi
        means agreeing to what follows.
      </p>

      <H2>What Printifi is, and isn&apos;t</H2>
      <p>
        Each print desk on Printifi is an independent business. It sets its own prices, its own hours and
        its own quality; it prints your documents and hands them to you. Printifi shows you the desk&apos;s
        prices, carries your files to it, tracks the job and records what happened. Printifi does not print
        anything. Where a desk takes payment through Printifi, Printifi&apos;s payment partner takes the
        money and Printifi passes the desk its share; everywhere else you pay the desk directly.
      </p>

      <H2>Prices and the platform fee</H2>
      <p>
        The full price is shown before you place an order, itemised per file, including a platform fee that
        is a percentage of the order and appears on the bill as its own line. The price you agree to is the
        price recorded on the order; it does not change afterwards, even if the desk changes its rates. Page
        counts are worked out from your file in your browser. If a file turns out to have more pages, or
        more colour pages, than were counted, the desk may send you a corrected bill before accepting the
        order: you see the new price and the reason, and accept it or cancel. Nothing is charged until you
        have.
      </p>
      <p>
        <b>Cover sheet.</b> Jobs come out of the printer under a labelled first page — your token, your
        first name, the pages and settings, the shelf slot — so the desk hands you the right pile. The desk
        charges for that sheet, ₹1 unless the desk sets a different price, and the charge is <b>included in
        the price you see</b> rather than shown as a separate line on the bill. It is part of the total
        before you order, is refunded with the order if the order is refunded in full, and goes to the desk
        like the rest of the bill. A desk can turn the sheet off; then nothing is charged for it.
      </p>
      <p>
        <b>Word, PowerPoint and Excel files</b> are turned into PDFs by a converter Printifi runs before the
        desk sees them, so what the desk prints is what you saw; the original is discarded once converted.
        Where the converter isn&apos;t available, the app asks for a PDF.
      </p>

      <H2>Paying</H2>
      <p>
        Two ways. You can pay the desk directly, by UPI to its own id or in cash; telling Printifi you have
        paid does not complete the payment — the desk confirms it when the money arrives, and may decline an
        order that hasn&apos;t been paid for. Or, where the desk has it, you can pay through Printifi
        (&ldquo;Pay · UPI, card&rdquo;): the payment is taken by Printifi&apos;s payment partner, Cashfree
        Payments, and the order is marked paid the moment it lands, with nothing for the desk to check. An
        order left unpaid past the desk&apos;s window is cancelled for you, and you&apos;re told.
      </p>

      <H2>Cash at the counter</H2>
      <p>
        Cash is a credit line. Within your cash limit, a cash order is printed straight away and you pay
        the desk when you collect; the limit starts at a small amount for a new account and grows each
        time you collect a cash order on time. One cash order can be open at a time. Above your limit
        you can still choose cash, but the desk prints when you tap <b>Leaving now</b> rather than
        before. If a cash order isn&apos;t collected within the desk&apos;s window, the bill becomes
        <b> dues</b> on your account: Printifi pays the desk for the job, and you can&apos;t place an order
        at any desk until the dues are paid — online through Printifi, or in cash at any desk. A second
        uncollected cash order switches cash off for your account for a season; online payment keeps
        working. The limits and windows are shown in the app at the moment you choose cash.
      </p>

      <H2>Collecting</H2>
      <p>
        Every order has a token and a QR code. Whoever shows the QR code collects the job — treat it like
        the ticket it is; if you share it, you have handed the job to that person. Your token may be shown
        on a screen at the counter so you can see when the job is ready; the screen shows tokens only. The
        cover sheet on the pile carries the token and the desk&apos;s id in its own code, and never your
        pickup code — a cover sheet proves nothing about who is collecting. A job left on the shelf past
        the desk&apos;s window is cleared as not collected: you&apos;re told, the files are deleted, and —
        because it was printed — what was paid for it isn&apos;t refunded by Printifi, and what wasn&apos;t
        yet paid for it becomes dues.
      </p>

      <H2>Delivery to your room</H2>
      <p>
        Where Printifi offers it and the desk is one Printifi&apos;s runner collects from, you can have the
        job brought to your hostel room instead of collecting it. You choose it when you order, give the
        hostel, room and a phone number the runner can call, and a <b>delivery fee</b> — shown as its own line
        on the bill, ₹10 unless the app shows otherwise — is added after the desk&apos;s bill. The fee is
        Printifi&apos;s, not the desk&apos;s. Delivery goes out on the runner&apos;s next round, so it can&apos;t
        take a booked pickup time; the app tells you when rounds go.
      </p>
      <p>
        The runner is a person Printifi has approved, carrying your job from the desk&apos;s shelf to your
        door. They see your name, phone, hostel and room for that job, and nothing else about you. At the
        door they scan the same QR code the counter would; a job handed over without a scan is recorded as
        such. If you chose cash, the runner takes the bill in cash at the door — a cash delivery is printed
        straight away whatever your cash limit, and an order you don&apos;t take becomes dues exactly as an
        uncollected counter order does. Paying online, or to the desk by UPI before it&apos;s printed, works
        as it always does.
      </p>
      <p>
        If the runner can&apos;t deliver — nobody at the door, a wrong room — the job goes back to the
        desk&apos;s shelf, you&apos;re told why, and you can collect it there with your token or wait for
        the next round; the desk&apos;s collection window runs from then. The delivery fee isn&apos;t
        refunded for a failed attempt, or if you collect at the desk yourself after choosing delivery. A
        delivery order that is never collected is cleared and becomes dues like any other, delivery fee
        included.
      </p>

      <H2>Problems, refunds and reports</H2>
      <p>
        If a print is wrong, report it from the order in the app; the desk sees the report and decides
        whether to reprint or refund. A payment made to the desk directly is refunded by the desk, the way
        you paid; a payment made through Printifi is refunded through Cashfree to what you paid with.
        Either way it&apos;s recorded on the order. The{" "}
        <Link href="/refunds" className="font-semibold text-ink underline-offset-2 hover:underline">refund policy</Link>{" "}
        has the detail.
      </p>

      <H2>What you may print</H2>
      <p>
        Only material you have the right to print. Nothing unlawful, and nothing that infringes someone
        else&apos;s copyright. A desk may refuse any job, and Printifi may close an account that repeatedly
        sends what it shouldn&apos;t. You are responsible for the content of your files.
      </p>

      <H2>Your account</H2>
      <p>
        Keep your sign-in to yourself; anything done from your account is yours. A desk account with a PIN
        on a shared counter device is the same: your PIN is your signature.
      </p>

      <H2>For print desks</H2>
      <p>
        Running a desk on Printifi means setting honest prices and hours; printing what was ordered, as it
        was ordered; handing jobs to the person holding the QR code; treating students&apos; files as
        confidential and opening them only to print them; and settling the platform fee on collected orders
        each month. A desk whose fee is overdue past the grace period cannot open until it settles.
        Printifi may remove a desk that doesn&apos;t keep to this. The full agreement is the{" "}
        <Link href="/desk-terms" className="font-semibold text-ink underline-offset-2 hover:underline">terms for print desks</Link>.
      </p>

      <H2>Availability and limits</H2>
      <p>
        Printifi is provided as it is. It is a small service and can be down, slow or wrong; a desk can be
        closed or out of paper. Printifi&apos;s responsibility to you is limited to what you paid Printifi —
        which, for a student, is the platform fee on the order in question. Printifi is not responsible for
        the quality of a desk&apos;s printing, for a desk&apos;s conduct, or for a file you should not have
        printed.
      </p>

      <H2>Changes and ending</H2>
      <p>
        These terms can change; the date at the top moves when they do, and continuing to use Printifi
        after that is agreeing to the new version. You can stop using Printifi at any time and ask for your
        account to be removed. Printifi may close an account that breaks these terms.
      </p>

      <H2>Law</H2>
      <p>These terms are governed by the laws of India.</p>

      <H2>Contact</H2>
      <Contact />
    </LegalPage>
  );
}
