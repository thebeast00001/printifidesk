import { Contact, H2, LegalPage } from "@/components/legal/legal-page";

export const metadata = {
  title: "Refund policy",
  description: "When a Printify order is refunded, by whom, how the money comes back, and what happens to an order that goes nowhere.",
};

/**
 * Every sentence here describes what the code does — the guard, the desk's
 * refund control, Cashfree's refund API, the sweep. When the code changes,
 * this page changes with it.
 */
export default function RefundsPage() {
  return (
    <LegalPage
      title="Refund policy"
      sub="When an order is refunded, by whom, how the money comes back, and what happens to an order that goes nowhere."
    >
      <p>
        Printify connects you to a print desk. The desk prints the job and, for most orders, is the one you
        pay — so the desk is the one that refunds. Where you paid <i>through Printify</i> (the &ldquo;Pay ·
        UPI, card&rdquo; button), Printify holds the money and moves the refund itself. This page says who
        does what, in which case.
      </p>

      <H2>Before anything is printed</H2>
      <p>
        You can cancel an order yourself from your orders page while it is <b>waiting for payment</b> or{" "}
        <b>in the queue</b>. Once the desk has started printing, the button is gone; ask at the counter.
      </p>
      <p>
        An order you haven&apos;t paid for isn&apos;t charged. If it stays unpaid past the desk&apos;s own
        window (shown on the order; usually a couple of hours), it is cancelled for you and you&apos;re told
        — nothing was taken, and you can order again when you&apos;re ready.
      </p>
      <p>
        If the desk finds the file doesn&apos;t match what was ordered — more pages, or more colour pages,
        than were counted — it can send you a <b>corrected bill</b> before accepting the order. You see the
        new price and the reason, and either accept it or cancel. Nothing is charged until you&apos;ve said.
      </p>

      <H2>If you paid the desk directly (UPI to the desk&apos;s id, or cash)</H2>
      <p>
        The money went straight to the desk; Printify never held it and cannot move it. A refund, whole or
        part, is the desk&apos;s decision and is paid by the desk, the way you paid — back to your UPI
        app, or in cash at the counter. When the desk records a refund, it appears on your order with the
        amount and the reason. Printify&apos;s platform fee, which is inside the bill, follows the refund:
        a fully refunded order carries no fee.
      </p>

      <H2>If you paid through Printify (&ldquo;Pay · UPI, card&rdquo;)</H2>
      <p>
        Your payment was taken by Printify&apos;s payment partner, Cashfree Payments, and the order was
        marked paid the moment it landed. A refund of such an order is made by the desk&apos;s owner from
        their portal, or by Printify, and is sent by Cashfree to the instrument you paid with — the same UPI
        account or card. Banks and UPI apps usually show it within a few working days; Cashfree&apos;s
        reference is on the order. The amount refunded can be the whole bill or a part of it, and is
        recorded on the order either way.
      </p>

      <H2>A print that&apos;s wrong</H2>
      <p>
        Report it from the order in the app — once it&apos;s ready, collected, or marked as failed. The desk
        sees the report and decides whether to reprint or refund. Printify records what was decided; the
        rules above say who moves the money.
      </p>

      <H2>A job nobody collected</H2>
      <p>
        A job marked <b>ready</b> waits on the desk&apos;s shelf. After the desk&apos;s own window — usually
        two days — it is cleared: the order shows as <b>not collected</b>, the files are deleted from
        Printify, and you are told. Because the job was printed, what was paid for it is not refunded by
        Printify; whether the desk keeps the pages or reprints is between you and the desk.
      </p>

      <H2>Fees and rounding</H2>
      <p>
        Every bill shows the desk&apos;s price and Printify&apos;s platform fee as separate lines, and — at
        a desk that rounds — what lifting to the next rupee added. A refund of the whole bill returns the
        whole bill, fee and rounding included.
      </p>

      <H2>Timing</H2>
      <p>
        Cash refunds are immediate. UPI refunds from a desk depend on the desk making the transfer.
        Refunds through Cashfree are submitted at once and typically arrive in 5–7 working days, depending
        on your bank.
      </p>

      <H2>Contact</H2>
      <Contact />
    </LegalPage>
  );
}
