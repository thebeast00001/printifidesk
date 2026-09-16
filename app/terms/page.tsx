import Link from "next/link";
import { Contact, H2, LegalPage } from "@/components/legal/legal-page";

export const metadata = {
  title: "Terms of service",
  description: "How Printify works between you, the print desk, and Printify itself.",
};

/** The rules, in the product's own voice, describing what it actually does. */
export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" sub="How Printify works between you, the print desk, and Printify itself.">
      <p>
        Printify connects people who need something printed with independent print desks on campus. The
        desk does the printing and takes your payment; Printify is the software in between. Using Printify
        means agreeing to what follows.
      </p>

      <H2>What Printify is, and isn&apos;t</H2>
      <p>
        Each print desk on Printify is an independent business. It sets its own prices, its own hours and
        its own quality; it prints your documents and hands them to you. Printify shows you the desk&apos;s
        prices, carries your files to it, tracks the job and records what happened. Printify does not print
        anything and does not take your money.
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

      <H2>Paying</H2>
      <p>
        Two ways. You can pay the desk directly, by UPI to its own id or in cash; telling Printify you have
        paid does not complete the payment — the desk confirms it when the money arrives, and may decline an
        order that hasn&apos;t been paid for. Or, where the desk has it, you can pay through Printify
        (&ldquo;Pay · UPI, card&rdquo;): the payment is taken by Printify&apos;s payment partner, Cashfree
        Payments, and the order is marked paid the moment it lands, with nothing for the desk to check. An
        order left unpaid past the desk&apos;s window is cancelled for you, and you&apos;re told.
      </p>

      <H2>Collecting</H2>
      <p>
        Every order has a token and a QR code. Whoever shows the QR code collects the job — treat it like
        the ticket it is; if you share it, you have handed the job to that person. A job left on the shelf
        past the desk&apos;s window is cleared as not collected: you&apos;re told, the files are deleted,
        and — because it was printed — what was paid for it isn&apos;t refunded by Printify.
      </p>

      <H2>Problems, refunds and reports</H2>
      <p>
        If a print is wrong, report it from the order in the app; the desk sees the report and decides
        whether to reprint or refund. A payment made to the desk directly is refunded by the desk, the way
        you paid; a payment made through Printify is refunded through Cashfree to what you paid with.
        Either way it&apos;s recorded on the order. The{" "}
        <Link href="/refunds" className="font-semibold text-ink underline-offset-2 hover:underline">refund policy</Link>{" "}
        has the detail.
      </p>

      <H2>What you may print</H2>
      <p>
        Only material you have the right to print. Nothing unlawful, and nothing that infringes someone
        else&apos;s copyright. A desk may refuse any job, and Printify may close an account that repeatedly
        sends what it shouldn&apos;t. You are responsible for the content of your files.
      </p>

      <H2>Your account</H2>
      <p>
        Keep your sign-in to yourself; anything done from your account is yours. A desk account with a PIN
        on a shared counter device is the same: your PIN is your signature.
      </p>

      <H2>For print desks</H2>
      <p>
        Running a desk on Printify means setting honest prices and hours; printing what was ordered, as it
        was ordered; handing jobs to the person holding the QR code; treating students&apos; files as
        confidential and opening them only to print them; and settling the platform fee on collected orders
        each month. A desk whose fee is overdue past the grace period cannot open until it settles.
        Printify may remove a desk that doesn&apos;t keep to this. The full agreement is the{" "}
        <Link href="/desk-terms" className="font-semibold text-ink underline-offset-2 hover:underline">terms for print desks</Link>.
      </p>

      <H2>Availability and limits</H2>
      <p>
        Printify is provided as it is. It is a small service and can be down, slow or wrong; a desk can be
        closed or out of paper. Printify&apos;s responsibility to you is limited to what you paid Printify —
        which, for a student, is the platform fee on the order in question. Printify is not responsible for
        the quality of a desk&apos;s printing, for a desk&apos;s conduct, or for a file you should not have
        printed.
      </p>

      <H2>Changes and ending</H2>
      <p>
        These terms can change; the date at the top moves when they do, and continuing to use Printify
        after that is agreeing to the new version. You can stop using Printify at any time and ask for your
        account to be removed. Printify may close an account that breaks these terms.
      </p>

      <H2>Law</H2>
      <p>These terms are governed by the laws of India.</p>

      <H2>Contact</H2>
      <Contact />
    </LegalPage>
  );
}
