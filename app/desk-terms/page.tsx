import { Contact, H2, LegalPage } from "@/components/legal/legal-page";
import { payoutWeekdayName } from "@/lib/server/platform";

// The payout day is read on every request, so the page says what the admin set.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Terms for print desks",
  description: "What running a desk on Printify commits you to: prices, printing, files, the platform fee, payouts, refunds and unclaimed jobs.",
};

/**
 * The agreement with a desk, in the same voice as the student's terms and
 * built from what the code does. Nothing here promises a schedule or a
 * number the code doesn't enforce or the admin doesn't set.
 */
export default async function DeskTermsPage() {
  const payoutDay = await payoutWeekdayName();
  return (
    <LegalPage
      title="Terms for print desks"
      sub="What running a desk on Printify commits you to: prices, printing, files, the platform fee, payouts, refunds and unclaimed jobs."
    >
      <p>
        Printify sends students&apos; print jobs to your desk and tells them when to collect. You set the
        prices, you print, you hand over. These are the terms you agree to when your desk is created and
        each time a member of your staff signs in. They sit alongside the general terms of service, which
        also apply to you.
      </p>

      <H2>Your desk, your rates</H2>
      <p>
        Every price a student sees is yours: per page in black and white and in colour, for both sides, for
        stapling, for any extras you name (spiral binding, lamination, paper sizes), your minimum order and
        your bulk rate. Change them whenever you like; orders already placed keep the prices they were placed
        at. Your hours, your days closed and your Open switch decide when students see you as open.
      </p>

      <H2>Owner and staff</H2>
      <p>
        A desk has at least one <b>owner</b>. Owners set rates, payment details, hours, extras and staff,
        pair devices, record refunds and see the takings. <b>Staff</b> run the queue: accept, print, hand
        over, message students, count stock. Roles are set by an owner under Staff; the last owner cannot
        step down without naming another.
      </p>

      <H2>Printing what was ordered</H2>
      <p>
        Print the file as it was ordered — pages, colour, sides, copies, extras — and hand the job to whoever
        shows its QR code or token. If a file doesn&apos;t match its order (more pages, more colour than were
        counted), send a corrected bill before accepting; the student accepts the new price or cancels. Once
        an order is paid, the bill stands; a shortfall is taken in cash at the counter and recorded.
      </p>

      <H2>Students&apos; files</H2>
      <p>
        Files are opened only to print them. Each opening is logged with who opened it. Files are deleted
        from Printify six hours after a job is collected or cleared as unclaimed. Don&apos;t copy, keep or
        share a student&apos;s file.
      </p>

      <H2>The platform fee</H2>
      <p>
        Printify&apos;s fee is a percentage of each order (with a small minimum), set by Printify, shown to
        the student as its own line on every bill and included in what they pay. For orders the student paid
        to you directly, the fee accrues on jobs collected (or cleared as unclaimed) and is settled to Printify
        monthly; the ledger in
        Takings shows what&apos;s due, and a desk whose fee is overdue past the grace period cannot open until
        it settles. For orders paid through Printify, the fee is kept at source and nothing is owed.
      </p>

      <H2>Payments through Printify</H2>
      <p>
        Where Printify has switched it on for your desk, students can pay through Printify&apos;s payment
        partner, Cashfree Payments. Such an order is marked paid and queued the moment the money lands; you
        print without checking anything. Your share — the bill less the platform fee, less any refund in
        proportion — is owed to you and paid out by Printify to the account you gave,{" "}
        {payoutDay ? (
          <>
            <b>every {payoutDay}</b>, for everything paid up to then.
          </>
        ) : (
          <>on the payout day shown in Takings.</>
        )}{" "}
        Takings lists every online-paid order with the bill, the fee, your share and Cashfree&apos;s payment
        reference, the running balance, and every payout with the exact orders it covered — downloadable for your
        accounts. The desk&apos;s owner can <b>pause payments through Printify at any time</b>; students then pay
        your UPI id directly, as always, and what is already owed is still paid out.
      </p>

      <H2>Refunds</H2>
      <p>
        You decide refunds for your jobs. A payment made directly to you is refunded by you, the way it was
        paid, and recorded on the order by an owner. A payment made through Printify is refunded by an owner
        from the portal and sent back by Cashfree to what the student paid with; the refund comes out of your
        share. The student-facing refund policy says the same from their side.
      </p>

      <H2>Jobs that go nowhere</H2>
      <p>
        You set two windows. An unpaid order past the first is cancelled and the student told. A ready job
        nobody collected past the second is cleared as unclaimed: its shelf slot frees, its files are deleted,
        the student is told, and what you were paid for it is yours — you printed it. What you do with the
        pages is up to you.
      </p>

      <H2>Conduct</H2>
      <p>
        Honest prices and hours; no printing of material you may not lawfully print; courtesy to students
        who report a problem. Printify can shut a desk that doesn&apos;t keep to this; its staff can finish
        the jobs already in hand and nothing more.
      </p>

      <H2>Ending</H2>
      <p>
        Leave whenever you like: unlist the desk, finish what&apos;s in the queue, settle any fee due. Order
        records and files are kept and deleted as the privacy policy describes.
      </p>

      <H2>Contact</H2>
      <Contact />
    </LegalPage>
  );
}
